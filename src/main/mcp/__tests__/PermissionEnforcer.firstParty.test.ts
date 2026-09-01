// First-party scoped-allowlist behavior in the Phase 2.2 enforcer.
//
// These cover the production lockout fix (plans/first-party-mcp-trust.md): the
// bundled wmux MCP server identifies as `claude-code` and is recorded
// `unconfirmed` in the trust DB, but must still be allowed to call the method
// set it actually uses — including `wmux.internal` methods (surface.list,
// surface.new/close, browser.tabs) that can never be declared/approved.

import { afterEach, describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext, RpcMethod } from '../../../shared/rpc';
import { check } from '../PermissionEnforcer';
import {
  FIRST_PARTY_METHODS,
  __resetConfiguredFirstPartyClientsForTests,
  setConfiguredFirstPartyClients,
} from '../firstParty';

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

const FP = 'claude-code';
// A representative spread of the allowlist: a normal capability method, a
// path-scoped one, and three that map to `wmux.internal` (the whole reason the
// allowlist exists — these can never be granted via declaration).
const SAMPLE_ALLOWED: RpcMethod[] = [
  'browser.open',
  'pane.setMetadata',
  'surface.list',
  'browser.tabs',
  'surface.new',
];

describe('PermissionEnforcer.check — first-party allowlist', () => {
  it('allows allowlisted methods for claude-code even when status=unconfirmed', () => {
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out, `${method} should be allowed for first-party/unconfirmed`).toEqual({
        kind: 'allow',
      });
    }
  });

  it('allows allowlisted methods for claude-code with NO trust record (fresh identify)', () => {
    // The actual live scenario: claude-code called mcp.identify, then a tool
    // RPC arrives before/without any declaration. trust may be undefined or a
    // bare unconfirmed row — either way the bundled server must work.
    const out = check({
      method: 'surface.list',
      params: {},
      ctx: ctx(FP),
      trust: undefined,
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows wmux.internal methods (surface.list, browser.tabs, surface.new/close) that can never be declared', () => {
    for (const method of [
      'surface.list',
      'browser.tabs',
      'surface.new',
      'surface.close',
    ] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out, `${method}`).toEqual({ kind: 'allow' });
    }
  });

  it.each([
    ['missing marker', ctx(FP, { externalWire: undefined })],
    ['trusted in-process source', ctx(FP, { externalWire: undefined, firstParty: true })],
    ['remote source', ctx(FP, { origin: 'remote' })],
    ['conflicting markers', ctx(FP, { firstParty: true })],
  ] satisfies [string, RpcContext][])('%s cannot enter the privileged name lane', (_label, sourceCtx) => {
    const out = check({
      method: 'surface.new',
      params: {},
      ctx: sourceCtx,
      trust: trust({
        name: FP,
        status: 'trusted',
        declaredCapabilities: ['ui.sidebar'],
      }),
    });
    expect(out.kind).toBe('reject');
  });

  it('allows the issue #285 pane/surface lifecycle methods (incl. reserved surface.new/close)', () => {
    // pane.split/close/focus are pane.create / pane.read; surface.new/close are
    // wmux.internal (reserved) and reachable ONLY via this first-party path (see
    // firstParty.test.ts ALLOWED_RESERVED_FIRST_PARTY + the §6 security review in
    // plans/issue-285-pane-lifecycle-mcp-tools.md). All five must be allowed so
    // the bundled supervisor can spawn/reap its own panes under enforce mode.
    for (const method of [
      'pane.split',
      'pane.close',
      'pane.focus',
      'surface.new',
      'surface.close',
    ] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out, `${method} should be first-party-allowed`).toEqual({ kind: 'allow' });
    }
  });

  it('honors an explicit denied as an operator escape hatch (denied wins over first-party)', () => {
    const out = check({
      method: 'browser.open',
      params: {},
      ctx: ctx(FP),
      trust: trust({ name: FP, status: 'denied' }),
    });
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject' || out.rejection.reason !== 'identity-status') {
      throw new Error('expected identity-status rejection');
    }
    expect(out.rejection.status).toBe('denied');
  });

  it('does NOT widen scope: a non-allowlisted method falls through to normal enforcement', () => {
    // daemon.shutdown / workspace.new are NOT in FIRST_PARTY_METHODS. Even for
    // claude-code they must NOT be auto-allowed — they fall through to the
    // unconfirmed/capability path and reject.
    for (const method of ['workspace.new', 'daemon.shutdown'] as const) {
      expect(FIRST_PARTY_METHODS.has(method)).toBe(false);
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must not be auto-allowed for first-party`).toBe('reject');
    }
  });

  it('SECURITY: a non-first-party clientName does NOT get the bypass for the same method', () => {
    // Once positive wire provenance is established, the bypass keys on the
    // exact first-party clientName. A wire client reporting some other name
    // hits the normal unconfirmed rejection — it cannot reach the allowlist by
    // calling an allowlisted method.
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx('totally-not-claude-code'),
        trust: trust({ name: 'totally-not-claude-code', status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must be rejected for a non-first-party caller`).toBe('reject');
    }
  });

  it('SECURITY: even spoofing clientName="claude-code" only reaches the curated set, never reserved daemon methods', () => {
    // Defense-in-depth assertion: the worst a clientName impersonator (who
    // already needs the daemon auth token) can do via the first-party path is
    // the allowlist — never daemon.shutdown/compact or company mutation.
    for (const method of ['daemon.shutdown', 'daemon.compact', 'company.create'] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must never be first-party-allowed`).toBe('reject');
    }
  });

  it('SECURITY: declines the first-party bypass when the trust lookup FAILED (a denied row may be unreadable)', () => {
    // A clean miss (trust=undefined, no failure) grants the bypass — see the
    // "NO trust record" test above. But when the trust-store read THREW (corrupt
    // DB / I/O), an operator `denied` row might exist and merely be unreadable.
    // Honoring first-party here would silently bypass that escape hatch, so the
    // enforcer must fall through to the fail-closed ladder instead. Symmetric
    // with non-first-party callers, which already fail closed on undefined trust.
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: undefined,
        trustLookupFailed: true,
      });
      expect(out.kind, `${method} must not be first-party-allowed on a failed lookup`).toBe(
        'reject',
      );
    }
  });

  it('still grants the first-party bypass on a clean miss (trustLookupFailed=false)', () => {
    // Regression guard for the live boot path: trust=undefined from a clean
    // lookup is the fresh-identify case and MUST keep working unchanged.
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: undefined,
        trustLookupFailed: false,
      });
      expect(out, `${method} should be allowed on a clean miss`).toEqual({ kind: 'allow' });
    }
  });
});

describe('PermissionEnforcer.check — config-configured first-party names (#636)', () => {
  afterEach(() => {
    __resetConfiguredFirstPartyClientsForTests();
  });

  it('grants a configured name the SAME curated allowlist, not a wider one', () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    for (const method of SAMPLE_ALLOWED) {
      expect(
        check({
          method,
          params: {},
          ctx: ctx('hermes-agent'),
          trust: trust({ name: 'hermes-agent', status: 'unconfirmed' }),
        }),
        `${method} should be allowed for a configured first-party name`,
      ).toEqual({ kind: 'allow' });
    }
    // The point of keeping FIRST_PARTY_METHODS compiled: config changes WHO is
    // recognised, never WHAT they may call.
    for (const method of ['daemon.shutdown', 'workspace.new'] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx('hermes-agent'),
        trust: trust({ name: 'hermes-agent', status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must NOT be granted by config`).toBe('reject');
    }
  });

  it('does not grant a configured-name collision from the trusted iframe source', () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    const out = check({
      method: 'surface.new',
      params: {},
      ctx: ctx('hermes-agent', { externalWire: undefined, firstParty: true }),
      trust: trust({
        name: 'hermes-agent',
        status: 'trusted',
        declaredCapabilities: ['ui.sidebar'],
      }),
    });
    expect(out.kind).toBe('reject');
  });

  it('keeps the three original guards for configured names', () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    // Guard 1 — an explicit user `denied` still wins.
    const denied = check({
      method: 'browser.open',
      params: {},
      ctx: ctx('hermes-agent'),
      trust: trust({ name: 'hermes-agent', status: 'denied' }),
    });
    expect(denied.kind).toBe('reject');
    // Guard 2 — a failed trust lookup declines the bypass (fail-closed).
    const unreadable = check({
      method: 'browser.open',
      params: {},
      ctx: ctx('hermes-agent'),
      trust: undefined,
      trustLookupFailed: true,
    });
    expect(unreadable.kind).toBe('reject');
  });

  it('a refused non-identifying name is NOT recognised by the enforcer', () => {
    // End-to-end version of the denylist: even if `mcp` reaches config, the
    // enforcer must still reject it — otherwise every anonymous Python-SDK
    // client would inherit the curated allowlist.
    setConfiguredFirstPartyClients(['mcp']);
    const out = check({
      method: 'surface.list',
      params: {},
      ctx: ctx('mcp'),
      trust: trust({ name: 'mcp', status: 'unconfirmed' }),
    });
    expect(out.kind).toBe('reject');
  });
});
