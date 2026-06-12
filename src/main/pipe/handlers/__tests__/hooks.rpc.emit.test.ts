// Integration tests for the `agent.lifecycle` event tee emitted from
// `hooks.signal`. Mocks `_bridge.sendToRenderer` (for workspace.list) and
// `sendNotification` (so we don't need a real BrowserWindow). The
// HookSignalRouter is a hand-rolled stub so we can control `recordHook`
// return values per test.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { eventBus } from '../../../events/EventBus';
import type { HookSignalRouter } from '../../../hooks/HookSignalRouter';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';

const { sendToRendererMock, sendNotificationMock, broadcastMetadataUpdateMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  broadcastMetadataUpdateMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../notification/sendNotification', () => ({
  sendNotification: sendNotificationMock,
}));

vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: broadcastMetadataUpdateMock,
}));

// Static import — vi.mock declarations are hoisted, so the module-under-test
// still picks up the mocked _bridge and sendNotification at evaluation time.
import { registerHooksRpc } from '../hooks.rpc';

function fakeWindow(): BrowserWindow {
  // Minimal stub — the handler only calls webContents.send for token usage
  // (not exercised in these tests) and isDestroyed checks.
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

interface StubRouter {
  router: HookSignalRouter;
  setDecision: (d: 'emit' | 'dedup') => void;
  recordHookCalls: { signal: AgentSignal; ptyId: string }[];
}

function stubHookRouter(): StubRouter {
  let decision: 'emit' | 'dedup' = 'emit';
  const recordHookCalls: { signal: AgentSignal; ptyId: string }[] = [];
  const router = {
    recordHook: (signal: AgentSignal, ptyId: string) => {
      recordHookCalls.push({ signal, ptyId });
      return decision;
    },
    recordDetector: vi.fn(),
    getLatencyMeter: () => ({
      recordSignal: vi.fn(),
      recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => vi.fn(),
      getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
  return {
    router,
    setDecision: (d) => { decision = d; },
    recordHookCalls,
  };
}

function signal(overrides: Partial<AgentSignal>): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function workspaces() {
  return [{
    id: 'ws-1',
    name: 'one',
    metadata: { cwd: '/repo' },
    activePtyId: 'pty-1',
    ptyIds: ['pty-1'],
  }];
}

interface PollResult {
  events: { type: string; ptyId?: string; source?: string; kind?: string; decision?: string; agent?: string; workspaceId?: string }[];
}

function pollLifecycle(): PollResult['events'] {
  const { events } = eventBus.poll(0, { types: ['agent.lifecycle'] });
  return events as PollResult['events'];
}

describe('hooks.signal — agent.lifecycle event tee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus.reset();
    sendToRendererMock.mockResolvedValue(workspaces());
  });

  it('emits agent.lifecycle on agent.stop hook with decision=emit', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '1',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent.lifecycle',
      ptyId: 'pty-1',
      workspaceId: 'ws-1',
      kind: 'agent.stop',
      source: 'hook',
      agent: 'claude',
      decision: 'emit',
    });
    // Regression: sendNotification still fires when decision=emit.
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('emits and lights the sidebar dot for agent.awaiting_input', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '8',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.awaiting_input' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.awaiting_input');
    // Sound/toast fires…
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // …and the sidebar dot is set to awaiting_input for the resolved pty.
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'awaiting_input' }),
    );
  });

  it('emits agent.lifecycle on dedup decision but skips sendNotification', async () => {
    const stub = stubHookRouter();
    stub.setDecision('dedup');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '2',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].decision).toBe('dedup');
    // Regression: dedup must NOT fire a duplicate toast.
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('emits agent.lifecycle for agent.subagent_stop kind', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '3',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.subagent_stop' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.subagent_stop');
  });

  it('does NOT emit for agent.activity (kept off the ring to avoid overflow)', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '4',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.activity' }) as unknown as Record<string, unknown>,
    });

    expect(pollLifecycle()).toHaveLength(0);
    // recordHook is dedup-gated to emit-kinds only — should NOT be called
    // for activity.
    expect(stub.recordHookCalls).toHaveLength(0);
  });

  it('does NOT emit for agent.session_start', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '5',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.session_start' }) as unknown as Record<string, unknown>,
    });

    expect(pollLifecycle()).toHaveLength(0);
  });

  it('does NOT emit when workspace match fails (signal from outside any wmux dir)', async () => {
    const stub = stubHookRouter();
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'ws-other', name: 'other', metadata: { cwd: '/not-repo' }, activePtyId: 'p-x', ptyIds: ['p-x'] },
    ]);
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '6',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop', cwd: '/repo' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    expect(pollLifecycle()).toHaveLength(0);
  });

  it('carries the agent slug through unchanged', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '7',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop', agent: 'codex' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe('codex');
  });
});
