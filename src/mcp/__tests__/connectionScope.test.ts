import { describe, it, expect, afterEach } from 'vitest';
import {
  createConnectionScope,
  runInConnectionScope,
  getConnectionScope,
} from '../connectionScope';
import {
  setClientIdentity,
  getClientIdentity,
  clearClientIdentity,
} from '../wmux-client';
import { getPinnedRoute, claimPinnedRoute, __resetPaneResolverForTesting } from '../paneResolver';
import { PlaywrightEngine } from '../playwright/PlaywrightEngine';

// Broker isolation invariants (Option A). The broker hosts N MCP server
// instances in ONE process; everything the single-child world kept in
// process globals must be per-connection or two agents bleed into each
// other — declared plugin identity onto RPC envelopes (trust attribution /
// first-party gating), the external caller's pinned route (terminal
// hijack), and the PlaywrightEngine (cross-pane browser session bleed,
// security-adjacent).

afterEach(() => {
  clearClientIdentity();
  __resetPaneResolverForTesting();
});

describe('connectionScope isolation', () => {
  it('client identity set inside a scope stays in that scope', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();

    runInConnectionScope(a, () => setClientIdentity('agent-a', '1.0'));
    runInConnectionScope(b, () => setClientIdentity('agent-b', '2.0'));

    expect(runInConnectionScope(a, () => getClientIdentity())).toEqual({
      name: 'agent-a',
      version: '1.0',
    });
    expect(runInConnectionScope(b, () => getClientIdentity())).toEqual({
      name: 'agent-b',
      version: '2.0',
    });
    // Module-global (single-child) identity untouched by scoped writes.
    expect(getClientIdentity()).toEqual({ name: undefined, version: undefined });
  });

  it('clearClientIdentity inside a scope does not clear another scope', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    runInConnectionScope(a, () => setClientIdentity('agent-a', '1.0'));
    runInConnectionScope(b, () => setClientIdentity('agent-b', '2.0'));

    runInConnectionScope(a, () => clearClientIdentity());

    expect(runInConnectionScope(a, () => getClientIdentity()).name).toBeUndefined();
    expect(runInConnectionScope(b, () => getClientIdentity()).name).toBe('agent-b');
  });

  it('pinned route is per scope — two external callers cannot share a claim', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    const claimFor = (ws: string, pty: string) =>
      ({ sendRpc: async () => ({ ptyId: pty, workspaceId: ws }) });

    await runInConnectionScope(a, () => claimPinnedRoute(claimFor('ws-a', 'pty-a')));
    await runInConnectionScope(b, () => claimPinnedRoute(claimFor('ws-b', 'pty-b')));

    expect(runInConnectionScope(a, () => getPinnedRoute())).toEqual({
      ptyId: 'pty-a',
      workspaceId: 'ws-a',
    });
    expect(runInConnectionScope(b, () => getPinnedRoute())).toEqual({
      ptyId: 'pty-b',
      workspaceId: 'ws-b',
    });
    // No leak into the process-global pin (single-child mode).
    expect(getPinnedRoute()).toBeNull();
  });

  it('PlaywrightEngine.getInstance is per scope, stable within a scope, singleton outside', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();

    const engineA1 = runInConnectionScope(a, () => PlaywrightEngine.getInstance());
    const engineA2 = runInConnectionScope(a, () => PlaywrightEngine.getInstance());
    const engineB = runInConnectionScope(b, () => PlaywrightEngine.getInstance());
    const global1 = PlaywrightEngine.getInstance();
    const global2 = PlaywrightEngine.getInstance();

    expect(engineA1).toBe(engineA2);
    expect(engineA1).not.toBe(engineB);
    expect(global1).toBe(global2);
    expect(global1).not.toBe(engineA1);
    expect(global1).not.toBe(engineB);
  });

  it('scope propagates through async continuations (transport-dispatch shape)', async () => {
    const a = createConnectionScope();
    const result = await runInConnectionScope(a, async () => {
      await new Promise((r) => setTimeout(r, 5));
      setClientIdentity('late-writer', '9.9');
      await new Promise((r) => setTimeout(r, 5));
      return getConnectionScope();
    });
    expect(result).toBe(a);
    expect(a.rpcIdentity.clientName).toBe('late-writer');
    expect(getClientIdentity().name).toBeUndefined();
  });
});
