// Statusline-push scoped-allowlist behavior in the permission enforcer (#1111).
//
// Mirrors PermissionEnforcer.hookBridge.test.ts for the `wmux-statusline`
// tier: the Claude Code statusline script reports clientName
// 'wmux-statusline' and gets EXACTLY one method, `usage.rateLimits`
// (statuslinePush.ts), with the same guards (denied wins, failed-lookup
// declines, out-of-set falls through, wire provenance required). The two
// lanes must not leak into each other.

import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext, RpcMethod } from '../../../shared/rpc';
import { check } from '../PermissionEnforcer';
import { STATUSLINE_PUSH_METHODS, WMUX_STATUSLINE_CLIENT_NAME } from '../statuslinePush';
import { HOOK_BRIDGE_METHODS, WMUX_HOOK_BRIDGE_CLIENT_NAME } from '../hookBridge';
import { WMUX_CLI_METHODS } from '../internalCli';
import { FIRST_PARTY_METHODS } from '../firstParty';
import { METHOD_CAPABILITY, resolveRequiredCapability } from '../methodCapabilityMap';

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

const STATUSLINE = WMUX_STATUSLINE_CLIENT_NAME;

describe('PermissionEnforcer.check — wmux-statusline allowlist', () => {
  it('allows usage.rateLimits for the statusline even when status=unconfirmed', () => {
    const out = check({
      method: 'usage.rateLimits',
      params: {},
      ctx: ctx(STATUSLINE),
      trust: trust({ name: STATUSLINE, status: 'unconfirmed' }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows usage.rateLimits with no trust record at all (first contact)', () => {
    const out = check({ method: 'usage.rateLimits', params: {}, ctx: ctx(STATUSLINE), trust: undefined });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('rejects everything outside the one-method set, hooks.signal included', () => {
    const outside: RpcMethod[] = [
      'hooks.signal',
      'pane.list',
      'pane.close',
      'input.send',
      'surface.list',
      'notify',
    ];
    for (const method of outside) {
      const out = check({
        method,
        params: {},
        ctx: ctx(STATUSLINE),
        trust: trust({ name: STATUSLINE, status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must not be reachable via the statusline lane`).toBe('reject');
    }
  });

  // The lane is an exemption from a security gate, so check the whole class it
  // could leak into rather than a hand-picked sample: every OTHER method that
  // resolves to the undeclarable `wmux.internal` capability must stay refused
  // for this name, whatever the trust row says short of a declaration.
  it('refuses every other wmux.internal method for the statusline name', () => {
    const internal = (Object.keys(METHOD_CAPABILITY) as RpcMethod[]).filter(
      (m) =>
        m !== 'usage.rateLimits' &&
        resolveRequiredCapability(METHOD_CAPABILITY[m], {}) === 'wmux.internal',
    );
    expect(internal.length).toBeGreaterThan(30);
    for (const method of internal) {
      for (const status of [undefined, 'unconfirmed', 'trusted'] as const) {
        const out = check({
          method,
          params: {},
          ctx: ctx(STATUSLINE),
          trust: status ? trust({ name: STATUSLINE, status, declaredCapabilities: [] }) : undefined,
        });
        expect(out.kind, `${method} (trust=${status ?? 'none'}) must not ride the statusline lane`).toBe('reject');
      }
    }
  });

  // Each provenance shape the guard must turn away, with the right name and
  // the right method. None of them may fall into the lane.
  it('refuses usage.rateLimits from every non-matching provenance', () => {
    const shapes: Array<[string, RpcContext]> = [
      ['no externalWire marker', { origin: 'local', clientName: STATUSLINE }],
      ['remote origin', { origin: 'remote', externalWire: true, clientName: STATUSLINE }],
      ['in-process nested dispatch', { origin: 'local', externalWire: undefined, firstParty: false, clientName: STATUSLINE }],
    ];
    for (const [label, c] of shapes) {
      const out = check({ method: 'usage.rateLimits', params: {}, ctx: c, trust: undefined });
      expect(out.kind, `${label} must not reach the statusline lane`).toBe('reject');
    }
  });

  it('the hook-bridge name does not reach usage.rateLimits', () => {
    const out = check({
      method: 'usage.rateLimits',
      params: {},
      ctx: ctx(WMUX_HOOK_BRIDGE_CLIENT_NAME),
      trust: trust({ name: WMUX_HOOK_BRIDGE_CLIENT_NAME, status: 'unconfirmed' }),
    });
    expect(out.kind).toBe('reject');
  });

  it('an explicit user denied still wins', () => {
    const out = check({
      method: 'usage.rateLimits',
      params: {},
      ctx: ctx(STATUSLINE),
      trust: trust({ name: STATUSLINE, status: 'denied' }),
    });
    expect(out.kind).toBe('reject');
  });

  it('declines the lane when the trust lookup failed (fail closed)', () => {
    const out = check({
      method: 'usage.rateLimits',
      params: {},
      ctx: ctx(STATUSLINE),
      trust: undefined,
      trustLookupFailed: true,
    });
    expect(out.kind).toBe('reject');
  });

  it('requires local external-wire provenance', () => {
    const out = check({
      method: 'usage.rateLimits',
      params: {},
      ctx: { origin: 'local', clientName: STATUSLINE },
      trust: undefined,
    });
    expect(out.kind).toBe('reject');
  });

  // #1111 regression: the shape #1639 shipped with. The push sent no
  // clientName and rode the grandfather.
  it('an envelope-less usage.rateLimits is refused (the closed grandfather lane)', () => {
    const out = check({ method: 'usage.rateLimits', params: {}, ctx: ctx(), trust: undefined });
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') throw new Error('expected reject');
    if (out.rejection.reason !== 'identity-status') throw new Error('expected identity-status');
    expect(out.rejection.status).toBe('legacy');
  });
});

describe('statuslinePush — allowlist invariants', () => {
  it('grants exactly one method', () => {
    expect([...STATUSLINE_PUSH_METHODS]).toEqual(['usage.rateLimits']);
  });

  it('does not overlap the hook-bridge, CLI or first-party allowlists', () => {
    for (const m of STATUSLINE_PUSH_METHODS) {
      expect(HOOK_BRIDGE_METHODS.has(m), `${m} unexpectedly in HOOK_BRIDGE_METHODS`).toBe(false);
      expect(WMUX_CLI_METHODS.has(m), `${m} unexpectedly in WMUX_CLI_METHODS`).toBe(false);
      expect(FIRST_PARTY_METHODS.has(m), `${m} unexpectedly in FIRST_PARTY_METHODS`).toBe(false);
    }
  });
});
