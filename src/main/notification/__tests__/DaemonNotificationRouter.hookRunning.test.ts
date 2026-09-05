// Hook-driven `running` on the daemon path.
//
// In daemon mode main never sees PTY bytes: HookIngest ingests the bridge
// signal and main replays it off the `session:agent` envelope. The turn START
// (`agent.user_prompt_submit`) rides the metadata class (`decision:'activity'`),
// which returns early before the ordinary status broadcast — so without an
// explicit branch the one signal that knows exactly when a turn begins would
// light nothing at all.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

const metadataHandlerMocks = vi.hoisted(() => {
  // Same faithful stand-in as DaemonNotificationRouter.statusClear.test.ts:
  // the funnel records the last broadcast status, which the idle clear reads.
  const lastBroadcastAgentStatus = new Map<string, string>();
  const broadcastMetadataUpdate = vi.fn(
    (_win: unknown, payload: { ptyId?: string; agentStatus?: string }) => {
      if (payload.ptyId && payload.agentStatus !== undefined) {
        lastBroadcastAgentStatus.set(payload.ptyId, payload.agentStatus);
      }
    },
  );
  return { broadcastMetadataUpdate, lastBroadcastAgentStatus };
});

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: metadataHandlerMocks.broadcastMetadataUpdate,
  getLastBroadcastAgentStatus: (ptyId: string) =>
    metadataHandlerMocks.lastBroadcastAgentStatus.get(ptyId),
  clearLastBroadcastAgentStatus: (ptyId: string) => {
    metadataHandlerMocks.lastBroadcastAgentStatus.delete(ptyId);
  },
}));

vi.mock('../dispatchNotification', () => ({
  dispatchNotification: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const broadcastMetadataUpdateMock = metadataHandlerMocks.broadcastMetadataUpdate;

const PTY = 'daemon-worker-pane';

interface Captured {
  idle?: (payload: { sessionId: string }) => void;
  agent?: (payload: { sessionId: string; event: unknown }) => void;
  active?: (payload: { sessionId: string; agentName?: string }) => void;
}

/**
 * A HookSignalRouter stub whose only interesting answer is whether the hook
 * owns this pane's running dot. `noteHookTurnStart` is recorded so the replay
 * branch's own write can be asserted.
 */
function stubHookRouter(runningGoverned: boolean): HookSignalRouter {
  return {
    noteHookTurnStart: vi.fn(),
    governsRunningState: vi.fn().mockReturnValue(runningGoverned),
    isGovernedFor: vi.fn().mockReturnValue(false),
    governsDetectorStatus: vi.fn().mockReturnValue(false),
    recordDetector: vi.fn().mockReturnValue('emit'),
    dropPty: vi.fn(),
  } as unknown as HookSignalRouter;
}

function makeRouter(hookRouter?: HookSignalRouter) {
  const captured: Captured = {};
  const fakeDaemon = {
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      if (event === 'session:idle') captured.idle = cb as Captured['idle'];
      if (event === 'session:agent') captured.agent = cb as Captured['agent'];
      if (event === 'session:active') captured.active = cb as Captured['active'];
    }),
    off: vi.fn(),
  } as unknown as DaemonClient;
  const router = new DaemonNotificationRouter(
    fakeDaemon,
    () => null,
    hookRouter ? () => hookRouter : undefined,
  );
  router.start();
  return { router, captured };
}

/** Last agentStatus this pane was broadcast, or undefined if never. */
function lastStatus(): string | undefined {
  const calls = broadcastMetadataUpdateMock.mock.calls.filter(
    ([, patch]) => (patch as { ptyId?: string }).ptyId === PTY,
  );
  const last = calls.at(-1)?.[1] as { agentStatus?: string } | undefined;
  return last?.agentStatus;
}

/** The metadata-class envelope HookIngest ships for one hook kind. */
function metadataEvent(hookKind: string, agent = 'Claude Code') {
  return {
    sessionId: PTY,
    event: {
      agent,
      status: 'running',
      message: '',
      source: 'hook',
      hookKind,
      decision: 'activity',
      signal: { kind: hookKind, agent: 'claude', cwd: '/repo', payload: {}, ts: 1 },
    },
  };
}

describe('DaemonNotificationRouter — turn start lights the pane', () => {
  beforeEach(() => {
    broadcastMetadataUpdateMock.mockClear();
    metadataHandlerMocks.lastBroadcastAgentStatus.delete(PTY);
  });

  it('broadcasts running on agent.user_prompt_submit, with no byte threshold', () => {
    const { router, captured } = makeRouter();
    captured.agent?.(metadataEvent('agent.user_prompt_submit'));
    expect(lastStatus()).toBe('running');
    // Identity rides along so the roster row can name the agent immediately.
    const patch = broadcastMetadataUpdateMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(patch.agentName).toBe('Claude Code');
    expect(patch.agentSlug).toBe('claude');
    router.stop();
  });

  it('is never throttled — two turns in a row both light the pane', () => {
    const { router, captured } = makeRouter();
    captured.agent?.(metadataEvent('agent.user_prompt_submit'));
    captured.agent?.(metadataEvent('agent.stop'));
    broadcastMetadataUpdateMock.mockClear();
    // The activity line's leading-edge throttle would swallow this second one
    // inside its 3s window; the turn start must not ride it.
    captured.agent?.(metadataEvent('agent.user_prompt_submit'));
    expect(lastStatus()).toBe('running');
    router.stop();
  });

  it('writes the status, not a Fleet activity line', () => {
    const { router, captured } = makeRouter();
    captured.agent?.(metadataEvent('agent.user_prompt_submit'));
    const patch = broadcastMetadataUpdateMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('activity');
    router.stop();
  });

  it('leaves the other metadata kinds exactly as they were', () => {
    const { router, captured } = makeRouter();
    // session_start is a CLEAR, not a status: it must not light the pane.
    captured.agent?.(metadataEvent('agent.session_start'));
    expect(lastStatus()).toBeUndefined();
    const patch = broadcastMetadataUpdateMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(patch.activity).toBe('');
    expect(patch.pendingQuestion).toBe('');
    router.stop();
  });
});

describe('DaemonNotificationRouter — the byte heuristic stands down on a hook-governed pane', () => {
  beforeEach(() => {
    broadcastMetadataUpdateMock.mockClear();
    metadataHandlerMocks.lastBroadcastAgentStatus.delete(PTY);
  });

  it('claims the running dot for the hook when the turn start lands', () => {
    const hookRouter = stubHookRouter(false);
    const { router, captured } = makeRouter(hookRouter);
    captured.agent?.(metadataEvent('agent.user_prompt_submit'));
    expect(hookRouter.noteHookTurnStart).toHaveBeenCalledWith(PTY, expect.any(Number));
    router.stop();
  });

  it('does not promote the pane to running on an output burst', () => {
    const { router, captured } = makeRouter(stubHookRouter(true));
    captured.agent?.(metadataEvent('agent.stop'));
    broadcastMetadataUpdateMock.mockClear();
    captured.active?.({ sessionId: PTY, agentName: 'Claude Code' });
    expect(broadcastMetadataUpdateMock).not.toHaveBeenCalled();
    router.stop();
  });

  it('does not clear the pane to idle on byte silence', () => {
    const { router, captured } = makeRouter(stubHookRouter(true));
    captured.active?.({ sessionId: PTY, agentName: 'Claude Code' });
    broadcastMetadataUpdateMock.mockClear();
    captured.idle?.({ sessionId: PTY });
    expect(broadcastMetadataUpdateMock).not.toHaveBeenCalled();
    router.stop();
  });

  it('leaves an UNGOVERNED pane on the heuristic, unchanged', () => {
    const { router, captured } = makeRouter(stubHookRouter(false));
    captured.active?.({ sessionId: PTY, agentName: 'Claude Code' });
    expect(lastStatus()).toBe('running');
    captured.idle?.({ sessionId: PTY });
    expect(lastStatus()).toBe('idle');
    router.stop();
  });
});
