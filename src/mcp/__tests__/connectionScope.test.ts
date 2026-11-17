import { describe, it, expect, afterEach } from 'vitest';
import {
  createConnectionScope,
  runInConnectionScope,
  getConnectionScope,
  markBrokerHost,
  resetBrokerHostForTests,
  scopeOrRefuse,
} from '../connectionScope';
import {
  setClientIdentity,
  getClientIdentity,
  clearClientIdentity,
  getCallerPtyId,
  getWorkspaceToken,
  runWithCallerPtyIdSource,
  setCallerPtyId,
  setCommanderRole,
  setWorkspaceToken,
} from '../wmux-client';
import {
  claimPinnedRoute,
  clearPinnedRoute,
  getPinnedRoute,
  __resetPaneResolverForTesting,
} from '../paneResolver';
import { PlaywrightEngine } from '../playwright/PlaywrightEngine';
import { deliberateSleep } from '../../test-utils/waitFor';

// Broker isolation invariants (Option A). The broker hosts N MCP server
// instances in ONE process; everything the single-child world kept in
// process globals must be per-connection or two agents bleed into each
// other — declared plugin identity onto RPC envelopes (trust attribution /
// first-party gating), the external caller's pinned route (terminal
// hijack), and the PlaywrightEngine (cross-pane browser session bleed,
// security-adjacent).

afterEach(() => {
  resetBrokerHostForTests();
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

  it('clearing a stale pin affects only the current connection', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    const claimFor = (ws: string, pty: string) => ({
      sendRpc: async () => ({ ptyId: pty, workspaceId: ws }),
    });

    await claimPinnedRoute(claimFor('ws-global', 'pty-global'));
    await runInConnectionScope(a, () => claimPinnedRoute(claimFor('ws-a', 'pty-a')));
    await runInConnectionScope(b, () => claimPinnedRoute(claimFor('ws-b', 'pty-b')));

    runInConnectionScope(a, () => clearPinnedRoute());

    expect(runInConnectionScope(a, () => getPinnedRoute())).toBeNull();
    expect(runInConnectionScope(b, () => getPinnedRoute())).toEqual({
      ptyId: 'pty-b',
      workspaceId: 'ws-b',
    });
    expect(getPinnedRoute()).toEqual({
      ptyId: 'pty-global',
      workspaceId: 'ws-global',
    });
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
      await deliberateSleep(5, 'real timer: the scope must survive a timer boundary');
      setClientIdentity('late-writer', '9.9');
      await deliberateSleep(5, 'real timer: the scope must survive a timer boundary');
      return getConnectionScope();
    });
    expect(result).toBe(a);
    expect(a.rpcIdentity.clientName).toBe('late-writer');
    expect(getClientIdentity().name).toBeUndefined();
  });
});

describe('in the broker, a call with no connection scope is refused', () => {
  const refused = /no MCP connection scope is active/;

  it('scopeOrRefuse: undefined in a single-child server, the scope inside one, a refusal in the broker', () => {
    expect(scopeOrRefuse('x')).toBeUndefined();
    markBrokerHost();
    expect(() => scopeOrRefuse('this call')).toThrow(/this call cannot be attributed/);
    const scope = createConnectionScope();
    expect(runInConnectionScope(scope, () => scopeOrRefuse('x'))).toBe(scope);
  });

  it('wmux-client identity, claim, caller pane and role refuse instead of using the process globals', () => {
    markBrokerHost();
    expect(() => setClientIdentity('a', '1')).toThrow(refused);
    expect(() => getClientIdentity()).toThrow(refused);
    expect(() => setWorkspaceToken('tok')).toThrow(refused);
    expect(() => getWorkspaceToken()).toThrow(refused);
    expect(() => setCallerPtyId('pty-1')).toThrow(refused);
    expect(() => getCallerPtyId()).toThrow(refused);
    expect(() => setCommanderRole('t')).toThrow(refused);
  });

  it('a per-call caller pane still answers without a scope (shared Codex app-server calls)', () => {
    markBrokerHost();
    expect(runWithCallerPtyIdSource(() => 'pty-9', () => getCallerPtyId())).toBe('pty-9');
  });

  it('teardown stays tolerant: clearing the identity with no scope does not throw', () => {
    markBrokerHost();
    expect(() => clearClientIdentity()).not.toThrow();
  });

  it('inside a scope everything works as before', () => {
    markBrokerHost();
    const scope = createConnectionScope();
    runInConnectionScope(scope, () => {
      setClientIdentity('agent-a', '1.0');
      setWorkspaceToken('tok-a');
      expect(getClientIdentity()).toEqual({ name: 'agent-a', version: '1.0' });
      expect(getWorkspaceToken()).toBe('tok-a');
    });
  });

  it('PlaywrightEngine.getInstance refuses with no scope, and gives each scope its own engine', () => {
    markBrokerHost();
    expect(() => PlaywrightEngine.getInstance()).toThrow(/this browser call cannot be attributed/);
    const a = createConnectionScope();
    const b = createConnectionScope();
    const ea = runInConnectionScope(a, () => PlaywrightEngine.getInstance());
    const eb = runInConnectionScope(b, () => PlaywrightEngine.getInstance());
    expect(ea).not.toBe(eb);
    expect(runInConnectionScope(a, () => PlaywrightEngine.getInstance())).toBe(ea);
  });
});
