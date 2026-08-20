// #935 direction 2, local half — the hook seam of the turn-end re-arm.
// `registerHooksRpc`'s `notePtyTurnEnd` dependency (wired to
// PTYBridge.noteTurnEnd in main/index.ts) must fire on the authoritative
// turn-end kinds and ONLY those:
//   - agent.stop        → yes (the boundary carries agentStatus 'complete')
//   - agent.awaiting_input → yes (terminal in the daemon's noteAgentStatus too)
//   - agent.session_start  → no (a turn BEGINNING builds a boundary as well —
//                             keying on the completion status is the point)
//   - agent.activity       → no (mid-turn working evidence)
// The stop-path call fires at the boundary write, BEFORE the verdict gate —
// same ordering as the daemon, which settles the bridge before broadcasting —
// so a held toast never delays the re-arm. Harness mirrors
// hooks.rpc.alarm.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { eventBus } from '../../../events/EventBus';
import type { HookSignalRouter } from '../../../hooks/HookSignalRouter';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';
import { CompletionAlarm, DEFAULT_ALARM_WINDOW_MS } from '../../../../shared/hooks/CompletionAlarm';

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

vi.mock('../../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { registerHooksRpc } from '../hooks.rpc';

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

function stubHookRouter(): HookSignalRouter {
  return {
    recordHook: vi.fn().mockReturnValue('emit'),
    recordDetector: vi.fn(),
    touchAuthority: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(false),
    governsDetectorStatus: vi.fn().mockReturnValue(false),
    getLatencyMeter: () => ({
      recordSignal: vi.fn(),
      recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => vi.fn(),
      getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
}

function signal(overrides: Partial<AgentSignal>): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  } as AgentSignal;
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

function rig(opts: { alarm?: CompletionAlarm; omitDep?: boolean } = {}) {
  const notePtyTurnEnd = vi.fn();
  const router = new RpcRouter();
  registerHooksRpc(
    router,
    () => fakeWindow(),
    stubHookRouter(),
    undefined,
    vi.fn(),
    undefined,
    opts.alarm,
    opts.omitDep ? undefined : notePtyTurnEnd,
  );
  return {
    notePtyTurnEnd,
    dispatch: (overrides: Partial<AgentSignal>) => router.dispatch({
      id: `t-${Math.random().toString(36).slice(2, 6)}`,
      method: 'hooks.signal',
      params: signal(overrides) as unknown as Record<string, unknown>,
    }) as Promise<{ ok: boolean }>,
  };
}

describe('hooks.signal — turn end re-arms the pane activity cycle (#935)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    eventBus.reset();
    sendToRendererMock.mockResolvedValue(workspaces());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('agent.stop fires notePtyTurnEnd with the resolved ptyId', async () => {
    const r = rig();
    const res = await r.dispatch({ kind: 'agent.stop' });
    expect(res.ok).toBe(true);
    expect(r.notePtyTurnEnd).toHaveBeenCalledTimes(1);
    expect(r.notePtyTurnEnd).toHaveBeenCalledWith('pty-1');
  });

  it('agent.awaiting_input fires it too — terminal in the daemon seam as well', async () => {
    const r = rig();
    await r.dispatch({ kind: 'agent.awaiting_input' });
    expect(r.notePtyTurnEnd).toHaveBeenCalledTimes(1);
    expect(r.notePtyTurnEnd).toHaveBeenCalledWith('pty-1');
  });

  it('agent.session_start builds a boundary but does NOT re-arm — a turn beginning is not an end', async () => {
    const r = rig();
    await r.dispatch({ kind: 'agent.session_start' });
    // The boundary metadata (activity clear) still broadcast…
    expect(broadcastMetadataUpdateMock).toHaveBeenCalled();
    // …but the re-arm is keyed on the completion status, which it lacks.
    expect(r.notePtyTurnEnd).not.toHaveBeenCalled();
  });

  it('mid-turn kinds (agent.activity) do not re-arm', async () => {
    const r = rig();
    await r.dispatch({ kind: 'agent.activity' });
    expect(r.notePtyTurnEnd).not.toHaveBeenCalled();
  });

  it('fires at the boundary write, before the verdict gate holds the toast', async () => {
    const alarm = new CompletionAlarm({
      onConfirmed: (_pane, _slug, _cls, resume) => resume(),
    });
    const r = rig({ alarm });
    // Working evidence so the gate holds (not drops) the stop.
    await r.dispatch({ kind: 'agent.activity' });
    vi.clearAllMocks();

    await r.dispatch({ kind: 'agent.stop' });
    // Held window: no toast yet — but the re-arm already happened, exactly
    // like the daemon settling the bridge before broadcasting.
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(r.notePtyTurnEnd).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // Confirmation fans out the toast without re-arming a second time.
    expect(r.notePtyTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('an absent dependency keeps the handler harmless (pre-#943 behavior)', async () => {
    const r = rig({ omitDep: true });
    const res = await r.dispatch({ kind: 'agent.stop' });
    expect(res.ok).toBe(true);
    expect(r.notePtyTurnEnd).not.toHaveBeenCalled();
  });
});
