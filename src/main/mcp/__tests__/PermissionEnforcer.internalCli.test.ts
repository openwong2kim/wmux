// Internal-CLI scoped-allowlist behavior in the permission enforcer.
//
// Mirrors PermissionEnforcer.firstParty.test.ts for the `wmux-cli` tier added in
// Stage 2 of the grandfather deprecation: the CLI reports clientName 'wmux-cli'
// and gets EXACTLY its curated method set (internalCli.ts) — a separate, narrower
// allowlist than the bundled-MCP FIRST_PARTY_METHODS — with the same guards
// (denied wins, failed-lookup declines, out-of-set falls through).

import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext, RpcMethod } from '../../../shared/rpc';
import { check } from '../PermissionEnforcer';
import { WMUX_CLI_METHODS, WMUX_CLI_CLIENT_NAME } from '../internalCli';

function trust(
  overrides: Partial<PluginIdentityRecord> & Pick<PluginIdentityRecord, 'name' | 'status'>,
): PluginIdentityRecord {
  return { firstSeen: 1000, lastSeen: 2000, ...overrides };
}
function ctx(clientName?: string): RpcContext {
  return clientName ? { origin: 'local', clientName } : { origin: 'local' };
}

const CLI = WMUX_CLI_CLIENT_NAME;
// A representative spread of the CLI allowlist: a normal capability method, and
// three reserved `wmux.internal` ones (lifecycle + notify) that can never be
// granted via declaration — name-recognition is the only path that reaches them.
const SAMPLE_ALLOWED: RpcMethod[] = ['input.send', 'workspace.new', 'surface.list', 'notify'];

describe('PermissionEnforcer.check — wmux-cli allowlist', () => {
  it('allows allowlisted methods for wmux-cli even when status=unconfirmed', () => {
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(CLI),
        trust: trust({ name: CLI, status: 'unconfirmed' }),
      });
      expect(out, `${method} should be allowed for wmux-cli/unconfirmed`).toEqual({ kind: 'allow' });
    }
  });

  it('allows allowlisted methods for wmux-cli with NO trust record (clean miss)', () => {
    const out = check({ method: 'workspace.new', params: {}, ctx: ctx(CLI), trust: undefined });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows reserved wmux.internal methods the CLI drives (surface/workspace lifecycle, notify)', () => {
    for (const method of ['surface.list', 'surface.new', 'workspace.close', 'notify'] as const) {
      const out = check({
        method,
        params: {},
        ctx: ctx(CLI),
        trust: trust({ name: CLI, status: 'unconfirmed' }),
      });
      expect(out, `${method}`).toEqual({ kind: 'allow' });
    }
  });

  it('honors an explicit denied as an operator escape hatch (denied wins over wmux-cli)', () => {
    const out = check({
      method: 'input.send',
      params: {},
      ctx: ctx(CLI),
      trust: trust({ name: CLI, status: 'denied' }),
    });
    expect(out.kind).toBe('reject');
  });

  it('does NOT widen scope: a gated method the CLI never calls falls through to reject', () => {
    // pane.setMetadata is a real gated method the bundled MCP calls but the CLI
    // does NOT — wmux-cli must not reach it. daemon.shutdown / company.create are
    // destructive and likewise absent from WMUX_CLI_METHODS.
    for (const method of ['pane.setMetadata', 'daemon.shutdown', 'company.create'] as const) {
      expect(WMUX_CLI_METHODS.has(method as RpcMethod)).toBe(false);
      const out = check({
        method,
        params: {},
        ctx: ctx(CLI),
        trust: trust({ name: CLI, status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must not be auto-allowed for wmux-cli`).toBe('reject');
    }
  });

  it('SECURITY: a different clientName does NOT get the wmux-cli bypass for a CLI method', () => {
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx('not-wmux-cli'),
        trust: trust({ name: 'not-wmux-cli', status: 'unconfirmed' }),
      });
      expect(out.kind, `${method} must be rejected for a non-CLI caller`).toBe('reject');
    }
  });

  it('SECURITY: declines the wmux-cli bypass when the trust lookup FAILED (a denied row may be unreadable)', () => {
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(CLI),
        trust: undefined,
        trustLookupFailed: true,
      });
      expect(out.kind, `${method} must not be wmux-cli-allowed on a failed lookup`).toBe('reject');
    }
  });

  it('still grants the wmux-cli bypass on a clean miss (trustLookupFailed=false)', () => {
    for (const method of SAMPLE_ALLOWED) {
      const out = check({
        method,
        params: {},
        ctx: ctx(CLI),
        trust: undefined,
        trustLookupFailed: false,
      });
      expect(out, `${method} should be allowed on a clean miss`).toEqual({ kind: 'allow' });
    }
  });
});
