// Hook-bridge scoped-allowlist behavior in the permission enforcer (#1111).
//
// Mirrors PermissionEnforcer.internalCli.test.ts for the `wmux-hook-bridge`
// tier: the agent lifecycle bridges under `integrations/<agent>/bin/` report
// clientName 'wmux-hook-bridge' and get EXACTLY one method, `hooks.signal`
// (hookBridge.ts) — a far narrower allowlist than either FIRST_PARTY_METHODS
// or WMUX_CLI_METHODS — with the same guards (denied wins, failed-lookup
// declines, out-of-set falls through, wire provenance required).

import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext, RpcMethod } from '../../../shared/rpc';
import { check } from '../PermissionEnforcer';
import { HOOK_BRIDGE_METHODS, WMUX_HOOK_BRIDGE_CLIENT_NAME } from '../hookBridge';
import { WMUX_CLI_METHODS } from '../internalCli';
import { FIRST_PARTY_METHODS } from '../firstParty';

function trust(
  overrides: Partial<PluginIdentityRecord> & Pick<PluginIdentityRecord, 'name' | 'status'>,
): PluginIdentityRecord {
  return { firstSeen: 1000, lastSeen: 2000, ...overrides };
}
function ctx(clientName?: string, overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    origin: 'local',
    externalWire: true,
    ...(clientName ? { clientName } : {}),
    ...overrides,
  };
}

const BRIDGE = WMUX_HOOK_BRIDGE_CLIENT_NAME;

describe('PermissionEnforcer.check — wmux-hook-bridge allowlist', () => {
  it('allows hooks.signal for the bridge even when status=unconfirmed', () => {
    const out = check({
      method: 'hooks.signal',
      params: {},
      ctx: ctx(BRIDGE),
      trust: trust({ name: BRIDGE, status: 'unconfirmed' }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows hooks.signal with no trust record at all (first contact)', () => {
    const out = check({ method: 'hooks.signal', params: {}, ctx: ctx(BRIDGE), trust: undefined });
    expect(out).toEqual({ kind: 'allow' });
  });

  // The whole point of a dedicated lane: the bridge must NOT inherit the CLI
  // or first-party surface. These are the methods a widened FIRST_PARTY_METHODS
  // would have handed a notify bridge.
  it('rejects everything outside the one-method set', () => {
    const outside: RpcMethod[] = [
      'pane.close',
      'surface.new',
      'surface.close',
      'input.send',
      'pane.setMetadata',
      'workspace.new',
      'notify',
    ];
    for (const method of outside) {
      const out = check({
        method,
        params: {},
        ctx: ctx(BRIDGE),
        trust: trust({ name: BRIDGE, status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must not be reachable via the hook-bridge lane`).toBe('reject');
    }
  });

  it('an explicit user denied still wins', () => {
    const out = check({
      method: 'hooks.signal',
      params: {},
      ctx: ctx(BRIDGE),
      trust: trust({ name: BRIDGE, status: 'denied' }),
    });
    expect(out.kind).toBe('reject');
  });

  it('declines the lane when the trust lookup failed (fail closed)', () => {
    const out = check({
      method: 'hooks.signal',
      params: {},
      ctx: ctx(BRIDGE),
      trust: undefined,
      trustLookupFailed: true,
    });
    expect(out.kind).toBe('reject');
  });

  it('requires local external-wire provenance', () => {
    const out = check({
      method: 'hooks.signal',
      params: {},
      ctx: { origin: 'local', clientName: BRIDGE },
      trust: undefined,
    });
    expect(out.kind).toBe('reject');
  });

  // #1111 regression: this is the shape that silently degraded turn-state
  // reporting. The bridges sent no clientName and rode the grandfather.
  it('an envelope-less hooks.signal is refused (the closed grandfather lane)', () => {
    const out = check({ method: 'hooks.signal', params: {}, ctx: ctx(), trust: undefined });
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') throw new Error('expected reject');
    if (out.rejection.reason !== 'identity-status') throw new Error('expected identity-status');
    expect(out.rejection.status).toBe('legacy');
  });

  it('a different clientName does not get the lane', () => {
    const out = check({
      method: 'hooks.signal',
      params: {},
      ctx: ctx('some-other-plugin'),
      trust: trust({ name: 'some-other-plugin', status: 'trusted', declaredCapabilities: ['pane.read'] }),
    });
    expect(out.kind).toBe('reject');
  });
});

describe('hookBridge — allowlist invariants', () => {
  it('grants exactly one method', () => {
    expect([...HOOK_BRIDGE_METHODS]).toEqual(['hooks.signal']);
  });

  // The lane exists BECAUSE hooks.signal is not in the other curated sets;
  // if it ever lands in one of them this lane should be revisited rather than
  // silently duplicating a grant.
  it('does not overlap the CLI or first-party allowlists', () => {
    for (const m of HOOK_BRIDGE_METHODS) {
      expect(WMUX_CLI_METHODS.has(m), `${m} unexpectedly in WMUX_CLI_METHODS`).toBe(false);
      expect(FIRST_PARTY_METHODS.has(m), `${m} unexpectedly in FIRST_PARTY_METHODS`).toBe(false);
    }
  });
});
