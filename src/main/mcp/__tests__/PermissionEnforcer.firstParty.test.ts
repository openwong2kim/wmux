// First-party scoped-allowlist behavior in the Phase 2.2 enforcer.
//
// These cover the production lockout fix (plans/first-party-mcp-trust.md): the
// bundled wmux MCP server identifies as `claude-code` and is recorded
// `unconfirmed` in the trust DB, but must still be allowed to call the method
// set it actually uses — including `wmux.internal` methods (surface.list,
// company.a2a.*) that can never be declared/approved.

import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext, RpcMethod } from '../../../shared/rpc';
import { check } from '../PermissionEnforcer';
import { FIRST_PARTY_METHODS } from '../firstParty';

function trust(
  overrides: Partial<PluginIdentityRecord> & Pick<PluginIdentityRecord, 'name' | 'status'>,
): PluginIdentityRecord {
  return { firstSeen: 1000, lastSeen: 2000, ...overrides };
}
function ctx(clientName?: string): RpcContext {
  return clientName ? { clientName } : {};
}

const FP = 'claude-code';
// A representative spread of the allowlist: a normal capability method, a
// path-scoped one, and two that map to `wmux.internal` (the whole reason the
// allowlist exists — these can never be granted via declaration).
const SAMPLE_ALLOWED: RpcMethod[] = [
  'browser.open',
  'pane.setMetadata',
  'surface.list',
  'company.a2a.whoami',
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

  it('allows wmux.internal methods (surface.list, company.a2a.*) that can never be declared', () => {
    for (const method of ['surface.list', 'company.a2a.send', 'company.a2a.status'] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out, `${method}`).toEqual({ kind: 'allow' });
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
    // The bypass keys on the exact first-party clientName. An external plugin
    // reporting some other name hits the normal unconfirmed rejection — it
    // cannot reach the allowlist by calling an allowlisted method.
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
