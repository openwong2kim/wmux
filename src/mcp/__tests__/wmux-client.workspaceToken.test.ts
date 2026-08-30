// #922 PR-A — the caller's half of the claim token: hold it, scope it to the
// connection that claimed it, and drop it when that connection goes.
//
// The isolation test is the one that matters. Under the broker, ONE process
// hosts N server instances, so a process-global token would let connection B
// stamp connection A's claim onto its own envelopes — B acting as A's
// workspace, which is precisely the confusion this whole track exists to end.
// `pinnedRoute` already lives per connection for the same reason; the token
// rides in the same scope object.
//
// Like `wmux-client.identity.test.ts`, these assert through the in-process
// getter rather than the wire: `attemptRpc` opens a real socket, and the
// getter reads the exact state it builds the envelope from. The end-to-end
// envelope round-trip is covered separately against a live pipe.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearClientIdentity,
  getWorkspaceToken,
  setClientIdentity,
  setWorkspaceToken,
} from '../wmux-client';
import { createConnectionScope, runInConnectionScope } from '../connectionScope';
import { claimPinnedRoute, __resetPaneResolverForTesting } from '../paneResolver';

beforeEach(() => {
  setWorkspaceToken(undefined);
  clearClientIdentity();
  __resetPaneResolverForTesting();
});

describe('wmux-client workspace claim token', () => {
  it('round-trips a token through the setter', () => {
    setWorkspaceToken('tok-abc');
    expect(getWorkspaceToken()).toBe('tok-abc');
  });

  it('treats blank and whitespace-only tokens as absent', () => {
    // An empty string would reach the substrate as a PRESENTED token that does
    // not resolve, which PR-B must refuse. Absent and stale are different
    // answers and the client must not manufacture the wrong one.
    setWorkspaceToken('tok-abc');
    setWorkspaceToken('   ');
    expect(getWorkspaceToken()).toBeUndefined();
    setWorkspaceToken('tok-abc');
    setWorkspaceToken(undefined);
    expect(getWorkspaceToken()).toBeUndefined();
  });

  it('trims padding so the stamped token matches the minted one', () => {
    setWorkspaceToken('  tok-padded  ');
    expect(getWorkspaceToken()).toBe('tok-padded');
  });

  it('is dropped with the rest of the identity by clearClientIdentity', () => {
    // Single-child mode calls this on transport close (`entry.ts`), so a
    // trailing RPC after teardown cannot keep presenting a claim on behalf of a
    // caller that has gone — the same reasoning clearClientIdentity documents
    // for the plugin name.
    //
    // The broker does NOT call it (`broker.ts` teardown), so this is not the
    // mechanism that protects broker connections. There the token is safe for a
    // different reason, pinned by the isolation tests below: each connection
    // owns its scope object and the scope is discarded with the connection, so
    // there is nothing left to leak into the next one.
    setClientIdentity('claude-code', '1.0.0');
    setWorkspaceToken('tok-abc');
    clearClientIdentity();
    expect(getWorkspaceToken()).toBeUndefined();
  });
});

describe('wmux-client workspace claim token — broker isolation', () => {
  it('keeps one connection\'s claim out of another\'s envelopes', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();

    runInConnectionScope(a, () => setWorkspaceToken('tok-a'));
    runInConnectionScope(b, () => setWorkspaceToken('tok-b'));

    expect(runInConnectionScope(a, () => getWorkspaceToken())).toBe('tok-a');
    expect(runInConnectionScope(b, () => getWorkspaceToken())).toBe('tok-b');
  });

  it('never writes a connection\'s token into the process globals', () => {
    // If the scope check were missed, the last connection to claim would leak
    // its token to the single-child path — and to every other connection.
    const scope = createConnectionScope();
    runInConnectionScope(scope, () => setWorkspaceToken('tok-scoped'));
    expect(getWorkspaceToken()).toBeUndefined();
  });

  it('does not let the process-global token leak into a connection', () => {
    setWorkspaceToken('tok-global');
    const scope = createConnectionScope();
    expect(runInConnectionScope(scope, () => getWorkspaceToken())).toBeUndefined();
  });

  it('clears only the connection that closed', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    runInConnectionScope(a, () => setWorkspaceToken('tok-a'));
    runInConnectionScope(b, () => setWorkspaceToken('tok-b'));

    runInConnectionScope(a, () => clearClientIdentity());

    expect(runInConnectionScope(a, () => getWorkspaceToken())).toBeUndefined();
    expect(runInConnectionScope(b, () => getWorkspaceToken())).toBe('tok-b');
  });
});

describe('paneResolver — handing the minted token over', () => {
  const CLAIM = { ptyId: 'daemon-mcp', workspaceId: 'ws-claimed' };

  it('publishes the token before the route, so no call is routed without it', async () => {
    const order: string[] = [];
    await claimPinnedRoute({
      sendRpc: async () => ({ ...CLAIM, workspaceToken: 'tok-minted' }),
      onWorkspaceToken: (token) => {
        order.push(`token:${token}`);
        setWorkspaceToken(token);
      },
    });
    order.push('claim-returned');

    expect(order).toEqual(['token:tok-minted', 'claim-returned']);
    expect(getWorkspaceToken()).toBe('tok-minted');
  });

  it('claims fine when main mints nothing', async () => {
    // An older main process, or an in-process caller, is issued no token. The
    // claim must succeed exactly as before — nothing in PR-A depends on it.
    const seen: string[] = [];
    const route = await claimPinnedRoute({
      sendRpc: async () => CLAIM,
      onWorkspaceToken: (t) => seen.push(t),
    });

    expect(route).toEqual(CLAIM);
    expect(seen).toEqual([]);
    expect(getWorkspaceToken()).toBeUndefined();
  });

  it('ignores a blank or non-string token from the wire', async () => {
    for (const workspaceToken of ['', '   ', 42, null, {}]) {
      __resetPaneResolverForTesting();
      const seen: string[] = [];
      await claimPinnedRoute({
        sendRpc: async () => ({ ...CLAIM, workspaceToken }),
        onWorkspaceToken: (t) => seen.push(t),
      });
      expect(seen, String(workspaceToken)).toEqual([]);
    }
  });

  it('works without the callback at all', async () => {
    const route = await claimPinnedRoute({
      sendRpc: async () => ({ ...CLAIM, workspaceToken: 'tok-minted' }),
    });
    expect(route).toEqual(CLAIM);
  });
});
