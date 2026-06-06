// First-party scoped-allowlist behavior in the Phase 2.2 enforcer.
//
// `clientName` is self-declared, so the first-party allowlist is only reachable
// when RpcRouter has verified the private first-party bearer credential.

import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext, RpcMethod } from '../../../shared/rpc';
import { check } from '../PermissionEnforcer';
import { FIRST_PARTY_METHODS } from '../firstParty';

function trust(
  overrides: Partial<PluginIdentityRecord> & Pick<PluginIdentityRecord, 'name' | 'status'>,
): PluginIdentityRecord {
  return { firstSeen: 1000, lastSeen: 2000, ...overrides };
}
function ctx(clientName?: string, firstPartyAuthenticated = false): RpcContext {
  return clientName ? { clientName, firstPartyAuthenticated } : {};
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
  it('allows allowlisted methods for claude-code when the first-party token is verified', () => {
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP, true),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out, `${method} should be allowed for token-authenticated first-party`).toEqual({
        kind: 'allow',
      });
    }
  });

  it('rejects claude-code with NO trust record when the first-party token is absent', () => {
    const out = check({
      method: 'surface.list',
      params: {},
      ctx: ctx(FP),
      trust: undefined,
    });
    expect(out.kind).toBe('reject');
  });

  it('allows claude-code with an unconfirmed trust record when the first-party token is verified', () => {
    const out = check({
      method: 'surface.list',
      params: {},
      ctx: ctx(FP, true),
      trust: trust({ name: FP, status: 'unconfirmed' }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows wmux.internal methods (surface.list, company.a2a.*) that can never be declared', () => {
    for (const method of ['surface.list', 'company.a2a.send', 'company.a2a.status'] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP, true),
        trust: trust({ name: FP, status: 'unconfirmed' }),
      });
      expect(out, `${method}`).toEqual({ kind: 'allow' });
    }
  });

  it('honors an explicit denied as an operator escape hatch (denied wins over first-party)', () => {
    const out = check({
      method: 'browser.open',
      params: {},
      ctx: ctx(FP, true),
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
        ctx: ctx(FP, true),
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

  it('SECURITY: untrusted spoofing clientName="claude-code" cannot reach reserved daemon methods', () => {
    // Defense-in-depth assertion: an unconfirmed clientName impersonator never
    // reaches daemon.shutdown/compact or company mutation.
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
    // When the trust-store read THREW (corrupt DB / I/O), an operator `denied`
    // row might exist and merely be unreadable. The enforcer must fall through
    // to the fail-closed ladder instead.
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP, true),
        trust: undefined,
        trustLookupFailed: true,
      });
      expect(out.kind, `${method} must not be first-party-allowed on a failed lookup`).toBe(
        'reject',
      );
    }
  });

  it('allows the first-party bypass on a clean miss only when the token is verified', () => {
    // A clean miss is safe only when paired with the private first-party token;
    // clientName alone is covered by the NO trust record rejection above.
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(FP, true),
        trust: undefined,
        trustLookupFailed: false,
      });
      expect(out, `${method} should allow on a token-verified clean miss`).toEqual({
        kind: 'allow',
      });
    }
  });
});
