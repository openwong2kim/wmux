// M1 — `hooks.signal` relays to the daemon when its client is connected, and
// only falls back to the pre-M1 local processing when it does not.
//
// The two behaviors that matter here are symmetric halves of one rule: a signal
// must be arbitrated in exactly ONE ledger. If the daemon took it, main must not
// touch its own HookSignalRouter (that would dedup the next same-kind signal
// against a decision the daemon already made); if the daemon did not take it,
// main must behave exactly as it did before M1.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { eventBus } from '../../../events/EventBus';
import type { DaemonClient } from '../../../DaemonClient';
import type { HookSignalRouter } from '../../../hooks/HookSignalRouter';
import type { AgentSignal, HookSignalResponse } from '../../../../../integrations/shared/signal-types';

const { sendToRendererMock, dispatchNotificationMock, broadcastMetadataUpdateMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  dispatchNotificationMock: vi.fn(),
  broadcastMetadataUpdateMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../notification/dispatchNotification', () => ({
  dispatchNotification: dispatchNotificationMock,
}));
vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: broadcastMetadataUpdateMock,
}));

import { registerHooksRpc, relayHookSignalToDaemon } from '../hooks.rpc';
import { DaemonNotificationRouter } from '../../../notification/DaemonNotificationRouter';

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

function stubHookRouter() {
  const recordHook = vi.fn().mockReturnValue('emit');
  const touchAuthority = vi.fn();
  const router = {
    recordHook,
    recordDetector: vi.fn(),
    touchAuthority,
    isGovernedFor: vi.fn().mockReturnValue(false),
    governsDetectorStatus: vi.fn().mockReturnValue(false),
    getLatencyMeter: () => ({
      recordSignal: vi.fn(),
      recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => vi.fn(),
      getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
  return { router, recordHook, touchAuthority };
}

function fakeDaemon(opts: {
  connected: boolean;
  rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const rpc = vi.fn(opts.rpc ?? (async () => ({ ok: true })));
  return {
    client: { isConnected: opts.connected, rpc } as unknown as DaemonClient,
    rpc,
  };
}

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

const WORKSPACES = [{
  id: 'ws-1',
  name: 'one',
  metadata: { cwd: '/repo' },
  activePtyId: 'pty-1',
  ptyIds: ['pty-1'],
}];

/** RpcResponse is a discriminated union; the handler's return rides in `result`. */
type DispatchResult = { ok: boolean; result?: HookSignalResponse };

async function dispatchSignal(
  daemon: DaemonClient | null,
  hookRouter: HookSignalRouter,
  params: Partial<AgentSignal> = {},
  onClaudeTurnEnd?: (workspaceId: string) => void,
): Promise<DispatchResult> {
  const router = new RpcRouter();
  registerHooksRpc(router, () => fakeWindow(), hookRouter, () => daemon, onClaudeTurnEnd);
  const res = await router.dispatch({
    id: '1',
    method: 'hooks.signal',
    params: signal(params) as unknown as Record<string, unknown>,
  });
  return res as DispatchResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  eventBus.reset();
  sendToRendererMock.mockResolvedValue(WORKSPACES);
});

describe('hooks.signal — daemon relay', () => {
  it('forwards the envelope to daemon.hooks.signal and returns its response verbatim', async () => {
    const { router: hookRouter, recordHook } = stubHookRouter();
    const daemon = fakeDaemon({ connected: true, rpc: async () => ({ ok: true }) });

    const res = await dispatchSignal(daemon.client, hookRouter, { ptyId: 'pty-1' });

    expect(res).toMatchObject({ ok: true, result: { ok: true } });
    expect(daemon.rpc).toHaveBeenCalledTimes(1);
    const [method, params] = daemon.rpc.mock.calls[0];
    expect(method).toBe('daemon.hooks.signal');
    expect(params).toMatchObject({ kind: 'agent.stop', agent: 'claude', cwd: '/repo', ptyId: 'pty-1' });
    // The daemon arbitrated: main touches neither the ledger nor any surface.
    expect(recordHook).not.toHaveBeenCalled();
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
    expect(sendToRendererMock).not.toHaveBeenCalled();
    expect(eventBus.poll(0, { types: ['agent.lifecycle'] }).events).toHaveLength(0);
  });

  it('passes a daemon rejection back to the bridge unchanged', async () => {
    const { router: hookRouter } = stubHookRouter();
    const daemon = fakeDaemon({
      connected: true,
      rpc: async () => ({ ok: false, reason: 'no-workspace-match' }),
    });

    const res = await dispatchSignal(daemon.client, hookRouter);

    expect(res.result).toEqual({ ok: false, reason: 'no-workspace-match' });
  });

  it('does NOT re-process locally when the daemon answers with an unexpected shape', async () => {
    // The daemon answered, so it ingested the signal — running the local path
    // too would double-fire the notification for the same turn.
    const { router: hookRouter, recordHook } = stubHookRouter();
    const daemon = fakeDaemon({ connected: true, rpc: async () => 'nonsense' });

    const res = await dispatchSignal(daemon.client, hookRouter);

    expect(res.result).toEqual({ ok: true });
    expect(recordHook).not.toHaveBeenCalled();
  });

  it('falls back to local processing when the daemon client is disconnected', async () => {
    const { router: hookRouter, recordHook, touchAuthority } = stubHookRouter();
    const daemon = fakeDaemon({ connected: false });

    const res = await dispatchSignal(daemon.client, hookRouter, { ptyId: 'pty-1' });

    expect(res.result).toEqual({ ok: true });
    expect(daemon.rpc).not.toHaveBeenCalled();
    expect(recordHook).toHaveBeenCalledTimes(1);
    expect(touchAuthority).toHaveBeenCalledWith('pty-1', 'claude');
    expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to local processing when there is no daemon client at all', async () => {
    const { router: hookRouter, recordHook } = stubHookRouter();

    const res = await dispatchSignal(null, hookRouter, { ptyId: 'pty-1' });

    expect(res.result).toEqual({ ok: true });
    expect(recordHook).toHaveBeenCalledTimes(1);
  });

  it('falls back when the daemon rejects the call (down, or too old to know the method)', async () => {
    // DaemonClient rejects on an `ok:false` reply, so `Unknown method:
    // daemon.hooks.signal` from a pre-M1 daemon arrives here as a throw.
    const { router: hookRouter, recordHook } = stubHookRouter();
    const daemon = fakeDaemon({
      connected: true,
      rpc: async () => { throw new Error('Unknown method: daemon.hooks.signal'); },
    });

    const res = await dispatchSignal(daemon.client, hookRouter, { ptyId: 'pty-1' });

    expect(res.result).toEqual({ ok: true });
    expect(daemon.rpc).toHaveBeenCalledTimes(1);
    expect(recordHook).toHaveBeenCalledTimes(1);
    expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed envelope in main without bothering the daemon', async () => {
    const { router: hookRouter } = stubHookRouter();
    const daemon = fakeDaemon({ connected: true });
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), hookRouter, () => daemon.client);

    const res = await router.dispatch({
      id: '1',
      method: 'hooks.signal',
      params: { kind: 'nope' } as unknown as Record<string, unknown>,
    }) as DispatchResult;

    expect(res.result).toEqual({ ok: false, reason: 'invalid-envelope' });
    expect(daemon.rpc).not.toHaveBeenCalled();
  });
});

describe('M1 side effects run on exactly ONE path', () => {
  // A hook signal can arrive three ways after M1. The turn-boundary broadcast
  // and the M2 usage probe must happen once per turn on all three — never twice
  // because both main and the daemon-event replay ran them.
  const HOOK_EVENT = {
    agent: 'Claude Code',
    status: 'complete' as const,
    message: 'Task finished',
    source: 'hook' as const,
    hookKind: 'agent.stop',
    decision: 'emit' as const,
    signal: signal({ ptyId: 'pty-1' }),
  };

  function boundaryBroadcasts() {
    return broadcastMetadataUpdateMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .filter((p) => 'pendingQuestion' in p);
  }

  /** Feed the daemon's arbitrated event into the router, as DaemonClient would. */
  async function deliverDaemonEvent(onClaudeTurnEnd: (workspaceId: string) => void) {
    let onAgent: ((p: { sessionId: string; event: unknown }) => void) | undefined;
    const fakeDaemon = {
      on: vi.fn((event: string, cb: (p: never) => void) => {
        if (event === 'session:agent') onAgent = cb as typeof onAgent;
      }),
      off: vi.fn(),
    } as unknown as DaemonClient;
    const router = new DaemonNotificationRouter(
      fakeDaemon,
      () => null,
      undefined,
      undefined,
      undefined,
      onClaudeTurnEnd,
    );
    router.start();
    try {
      onAgent!({ sessionId: 'pty-1', event: HOOK_EVENT });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      router.stop();
    }
  }

  it('bridge → main relay → daemon: main runs none of them, the replay runs each once', async () => {
    const { router: hookRouter } = stubHookRouter();
    const daemon = fakeDaemon({ connected: true, rpc: async () => ({ ok: true }) });
    const onClaudeTurnEnd = vi.fn();

    await dispatchSignal(daemon.client, hookRouter, { ptyId: 'pty-1' }, onClaudeTurnEnd);

    // Main relayed and returned — it must not have touched any surface.
    expect(boundaryBroadcasts()).toHaveLength(0);
    expect(onClaudeTurnEnd).not.toHaveBeenCalled();

    // …then the daemon's event arrives and the replay runs each exactly once.
    await deliverDaemonEvent(onClaudeTurnEnd);
    expect(boundaryBroadcasts()).toHaveLength(1);
    expect(onClaudeTurnEnd).toHaveBeenCalledExactlyOnceWith('ws-1');
  });

  it('bridge → daemon direct: the replay is the only path and runs each once', async () => {
    const onClaudeTurnEnd = vi.fn();
    await deliverDaemonEvent(onClaudeTurnEnd);

    expect(boundaryBroadcasts()).toHaveLength(1);
    expect(onClaudeTurnEnd).toHaveBeenCalledExactlyOnceWith('ws-1');
  });

  it('daemon down: main runs each once locally and no daemon event follows', async () => {
    const { router: hookRouter, recordHook } = stubHookRouter();
    const daemon = fakeDaemon({ connected: false });
    const onClaudeTurnEnd = vi.fn();

    await dispatchSignal(daemon.client, hookRouter, { ptyId: 'pty-1' }, onClaudeTurnEnd);

    expect(recordHook).toHaveBeenCalledTimes(1);
    expect(boundaryBroadcasts()).toHaveLength(1);
    expect(boundaryBroadcasts()[0]).toMatchObject({
      ptyId: 'pty-1',
      activity: '',
      agentStatus: 'complete',
    });
    expect(onClaudeTurnEnd).toHaveBeenCalledExactlyOnceWith('ws-1');
  });
});

describe('relayHookSignalToDaemon', () => {
  it('returns null for a null client', async () => {
    expect(await relayHookSignalToDaemon(null, signal())).toMatchObject({ response: null, mayProcessLocally: true });
  });

  it('returns null for a disconnected client without calling rpc', async () => {
    const rpc = vi.fn();
    const client = { isConnected: false, rpc } as unknown as DaemonClient;
    expect(await relayHookSignalToDaemon(client, signal())).toMatchObject({ response: null, mayProcessLocally: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does NOT reprocess locally after an ambiguous failure', async () => {
    // A timeout rejects AFTER the write, so the daemon may already have ingested
    // and broadcast the signal. Replaying it here would double-fire the
    // notification and write a second entry into a divergent ledger — the same
    // rule the bridge applies in shouldTryNextTarget.
    for (const message of [
      'RPC timeout: daemon.hooks.signal (1500ms)',
      'DaemonClient disconnecting',
      'DaemonClient disconnected',
    ]) {
      const client = {
        isConnected: true,
        rpc: async () => { throw new Error(message); },
      } as unknown as DaemonClient;
      const out = await relayHookSignalToDaemon(client, signal());
      expect(out.mayProcessLocally).toBe(false);
      expect(out.canonical).toBe(false);
      expect(out.response).toEqual({ ok: false, reason: 'internal-error' });
    }
  });

  it('DOES process locally when the daemon provably refused', async () => {
    // A pre-M1 daemon replies "Unknown method", which DaemonClient surfaces as
    // a throw. That is a refusal, not an ambiguity — treating it as ambiguous
    // would take hooks silent for anyone upgrading past an old daemon.
    for (const message of [
      'Unknown method: daemon.hooks.signal',
      'unauthorized',
      'DaemonClient not connected',
    ]) {
      const client = {
        isConnected: true,
        rpc: async () => { throw new Error(message); },
      } as unknown as DaemonClient;
      const out = await relayHookSignalToDaemon(client, signal());
      expect(out.mayProcessLocally).toBe(true);
      expect(out.response).toBeNull();
    }
  });

  it('marks an unreadable daemon answer as non-canonical', async () => {
    // Still stops the caller (the daemon answered, so it ingested), but must
    // not be scored as a verdict — it is not one.
    const client = {
      isConnected: true,
      rpc: async () => 'nonsense',
    } as unknown as DaemonClient;
    const out = await relayHookSignalToDaemon(client, signal());
    expect(out.mayProcessLocally).toBe(false);
    expect(out.canonical).toBe(false);
    expect(out.response).toEqual({ ok: true });
  });

  it('sends the envelope under a budget below the bridge 2s cap', async () => {
    const rpc = vi.fn(async () => ({ ok: true }));
    const client = { isConnected: true, rpc } as unknown as DaemonClient;
    await relayHookSignalToDaemon(client, signal());
    const opts = (rpc.mock.calls[0] as unknown as unknown[])[2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeLessThan(2000);
  });
});
