// Tests for the `agent.lifecycle` EventBus tee fired from
// DaemonNotificationRouter. Two sources are covered:
//
//   - detector — session:agent payloads with status 'waiting' / 'complete'
//                emit kind:'agent.stop'; status 'awaiting_input' emits
//                kind:'agent.awaiting_input' (new in PR #76).
//   - osc133   — session:prompt payloads with type:'command_end' tee onto
//                the EventBus as source:'osc133' (new in PR #76, daemon-mode
//                mirror of PTYBridge.OscParser case 133).
//
// The existing cache test (DaemonNotificationRouter.cache.test.ts) covers
// the workspace.list resolution path; this file focuses on dispatch shape.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { eventBus } from '../../events/EventBus';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
  // #935 direction 3: PTYBridge/DaemonNotificationRouter import these from
  // the real module; this suite does not exercise the deferral logic, so
  // no-op stubs are enough to keep the import from throwing.
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => { /* no-op stub */ },
}));

vi.mock('../sendNotification', () => ({
  sendNotification: vi.fn(),
}));

// The router now funnels user-visible surfaces through dispatchNotification
// (renderer-decided OS toast); this file only asserts the EventBus tee, so
// the dispatch layer is stubbed out entirely.
vi.mock('../dispatchNotification', () => ({
  dispatchNotification: vi.fn(),
}));

vi.mock('../idleSuppression', () => ({
  clearPty: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

// The transcript reader does real file I/O; the M1 replay only needs to prove it
// is called with the envelope's path and that the result rides the tee.
vi.mock('../../claude/lastAssistantMessage', () => ({
  readLastAssistantMessage: vi.fn(),
}));

import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { dispatchNotification } from '../dispatchNotification';
import { broadcastMetadataUpdate } from '../../ipc/handlers/metadata.handler';
import { readLastAssistantMessage } from '../../claude/lastAssistantMessage';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const dispatchNotificationMock = vi.mocked(dispatchNotification);
const broadcastMetadataUpdateMock = vi.mocked(broadcastMetadataUpdate);
const readLastAssistantMessageMock = vi.mocked(readLastAssistantMessage);

const sendToRendererMock = vi.mocked(sendToRenderer);

const FIXTURE_WORKSPACE_LIST = [
  { id: 'ws-1', name: 'Workspace 1', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] },
];

interface CapturedListeners {
  agent?: (payload: { sessionId: string; event: unknown }) => void;
  prompt?: (payload: { sessionId: string; event: unknown }) => void;
  died?: (payload: { sessionId: string }) => void;
}

function makeRouter(opts: {
  hookRouter?: HookSignalRouter | null;
  onClaudeTurnEnd?: (workspaceId: string) => void;
} = {}) {
  const captured: CapturedListeners = {};
  const fakeDaemon = {
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      if (event === 'session:agent') captured.agent = cb as CapturedListeners['agent'];
      if (event === 'session:prompt') captured.prompt = cb as CapturedListeners['prompt'];
      if (event === 'session:died') captured.died = cb as CapturedListeners['died'];
    }),
    off: vi.fn(),
  } as unknown as DaemonClient;
  const getHookRouter = opts.hookRouter !== undefined ? () => opts.hookRouter ?? null : undefined;
  const router = new DaemonNotificationRouter(
    fakeDaemon,
    () => null,
    getHookRouter,
    undefined,
    undefined,
    opts.onClaudeTurnEnd,
  );
  router.start();
  return { router, captured };
}

function stubHookRouter(decision: 'emit' | 'dedup'): HookSignalRouter {
  return {
    recordDetector: vi.fn().mockReturnValue(decision),
    recordHook: vi.fn().mockReturnValue('emit'),
    touchAuthority: vi.fn(),
    // Tests here exercise the detector tee — no pane is hook-governed.
    isGovernedFor: vi.fn().mockReturnValue(false),
    governsDetectorStatus: vi.fn().mockReturnValue(false),
  } as unknown as HookSignalRouter;
}

function pollLifecycle() {
  return eventBus.poll(0, { types: ['agent.lifecycle'] }).events;
}

async function flushMicrotasks(): Promise<void> {
  // emitDetectorLifecycle / emitOsc133Lifecycle await resolveWorkspaceIdForPty,
  // which awaits the mocked sendToRenderer. Two ticks is enough to settle both.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue(FIXTURE_WORKSPACE_LIST);
  readLastAssistantMessageMock.mockReset();
  readLastAssistantMessageMock.mockReturnValue(null);
  eventBus.reset();
});

afterEach(() => {
  eventBus.reset();
});

describe('DaemonNotificationRouter — detector lifecycle tee (awaiting_input)', () => {
  it('emits kind:"agent.awaiting_input" when session:agent reports status awaiting_input', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      const awaiting = events.find((e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input');
      expect(awaiting).toMatchObject({
        type: 'agent.lifecycle',
        workspaceId: 'ws-1',
        ptyId: 'pty-a',
        kind: 'agent.awaiting_input',
        source: 'detector',
        agent: 'claude',
        decision: 'emit',
      });
    } finally {
      router.stop();
    }
  });

  it('still emits kind:"agent.stop" for waiting/complete (regression)', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'waiting', message: 'Ready for input' },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ kind: 'agent.stop', source: 'detector' });
    } finally {
      router.stop();
    }
  });

  it('routes awaiting_input through HookSignalRouter.recordDetector with the matching kind', async () => {
    const router = stubHookRouter('emit');
    const { router: nr, captured } = makeRouter({ hookRouter: router });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' },
      });
      await flushMicrotasks();

      expect(router.recordDetector).toHaveBeenCalledWith('claude', 'agent.awaiting_input', 'pty-a');
    } finally {
      nr.stop();
    }
  });

  it('hook-authority veto: governed (ptyId, slug) suppresses notification, ledger write and tee', async () => {
    // Daemon-mode twin of the PTYBridge veto test. While the pane's hook
    // bridge is fresh for the same agent, the detector must not dispatch,
    // must not write the dedup ledger (that would kill the real Stop hook),
    // and must not tee a lifecycle event (the hook emits the canonical one).
    const hookRouter = {
      recordDetector: vi.fn(),
      recordHook: vi.fn(),
      touchAuthority: vi.fn(),
      isGovernedFor: vi.fn().mockReturnValue(true),
      // #935: the status broadcast rides the same authority as the veto.
      governsDetectorStatus: vi.fn(
        (_p: string, slug: string | null | undefined, status: string) =>
          !!slug && (status === 'waiting' || status === 'complete'),
      ),
    } as unknown as HookSignalRouter;
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'waiting', message: 'Ready for input' },
      });
      await flushMicrotasks();

      expect(vi.mocked(hookRouter.isGovernedFor)).toHaveBeenCalledWith('pty-a', 'claude');
      expect(hookRouter.recordDetector).not.toHaveBeenCalled();
      expect(pollLifecycle()).toHaveLength(0);
    } finally {
      nr.stop();
    }
  });

  it('#935 REGRESSION (M1 production arm): a daemon-vetoed detector "waiting" never reaches agentStatus', async () => {
    // THE path the packaged build takes. `hooks.rpc` returns at the daemon
    // relay, ABOVE its own `touchAuthority` call, so main's router never gains
    // authority over a daemon-served pane — `governsDetectorStatus` is false
    // here and the daemon's `decision: 'veto'` stamp is the whole mechanism.
    // Stubbing the router to true instead would pass while testing a branch
    // production never takes (team review catch).
    //
    // Claude's `bypass permissions on` footer is on screen for the whole turn,
    // so an ungated status broadcast marked a working pane 'waiting' and
    // inflated the "N need you" chip.
    const hookRouter = stubHookRouter('emit'); // governsDetectorStatus → false
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'waiting',
          message: 'Ready for input',
          source: 'detector',
          decision: 'veto',
        },
      });
      await flushMicrotasks();

      const statusCalls = broadcastMetadataUpdateMock.mock.calls.filter(
        (c) => (c[1] as { agentStatus?: string }).agentStatus === 'waiting',
      );
      expect(statusCalls).toHaveLength(0);
      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toMatchObject({
        ptyId: 'pty-a',
        agentName: 'Claude Code',
        agentSlug: 'claude',
      });
    } finally {
      nr.stop();
    }
  });

  it('#935 pre-M1 fallback arm: an UNARBITRATED detector "waiting" on a governed pane is withheld', async () => {
    // No `source` stamp means an older daemon (or the local fallback), where
    // main's own authority is the only thing that knows.
    const hookRouter = {
      recordDetector: vi.fn(),
      recordHook: vi.fn(),
      touchAuthority: vi.fn(),
      isGovernedFor: vi.fn().mockReturnValue(true),
      governsDetectorStatus: vi.fn().mockReturnValue(true),
    } as unknown as HookSignalRouter;
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'waiting', message: 'Ready for input' },
      });
      await flushMicrotasks();

      expect(vi.mocked(hookRouter.governsDetectorStatus)).toHaveBeenCalledWith('pty-a', 'claude', 'waiting');
      const statusCalls = broadcastMetadataUpdateMock.mock.calls.filter(
        (c) => (c[1] as { agentStatus?: string }).agentStatus === 'waiting',
      );
      expect(statusCalls).toHaveLength(0);
    } finally {
      nr.stop();
    }
  });

  it('#935 an ARBITRATED hook event keeps its status — main must not re-run its own authority on the daemon\'s judgement', async () => {
    // The pane IS governed (by this very signal). Applying main's authority to
    // a hook-sourced event would withhold the hook's own completion status,
    // leaving the roster to depend entirely on the later boundary re-broadcast.
    const hookRouter = {
      recordDetector: vi.fn(),
      recordHook: vi.fn(),
      touchAuthority: vi.fn(),
      isGovernedFor: vi.fn().mockReturnValue(true),
      governsDetectorStatus: vi.fn().mockReturnValue(true),
    } as unknown as HookSignalRouter;
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Task finished',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'emit',
        },
      });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toMatchObject({
        ptyId: 'pty-a',
        agentStatus: 'complete',
      });
    } finally {
      nr.stop();
    }
  });

  it('#935 a "veto" stamped on awaiting_input is refused locally — daemon-skew defence', async () => {
    // Today the daemon never stamps 'veto' on awaiting_input (HookIngest), but
    // that guarantee lives in another process. An older daemon paired with this
    // main must not be able to hide a real approval prompt for the authority TTL.
    const hookRouter = stubHookRouter('emit');
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'awaiting_input',
          message: 'Approval requested',
          source: 'detector',
          decision: 'veto',
        },
      });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toMatchObject({
        ptyId: 'pty-a',
        agentStatus: 'awaiting_input',
      });
    } finally {
      nr.stop();
    }
  });

  it('codex review catch (round 2): the veto does NOT cover awaiting_input — daemon-mode twin of the PTYBridge exemption test', async () => {
    // Same rationale as the PTYBridge test: Claude's hooks.json only wires
    // PreToolUse for AskUserQuestion — generic approval prompts ("Do you
    // want to proceed?") have no hook, so the detector must remain the
    // live signal source for awaiting_input regardless of hook authority.
    const hookRouter = {
      recordDetector: vi.fn().mockReturnValue('emit'),
      recordHook: vi.fn(),
      touchAuthority: vi.fn(),
      isGovernedFor: vi.fn().mockReturnValue(true),
      // #935: the status broadcast rides the same authority as the veto.
      governsDetectorStatus: vi.fn(
        (_p: string, slug: string | null | undefined, status: string) =>
          !!slug && (status === 'waiting' || status === 'complete'),
      ),
    } as unknown as HookSignalRouter;
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      dispatchNotificationMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' },
      });
      await flushMicrotasks();

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const events = pollLifecycle();
      const awaiting = events.find((e) => e.type === 'agent.lifecycle' && e.kind === 'agent.awaiting_input');
      expect(awaiting).toBeDefined();
      expect(awaiting).toMatchObject({ decision: 'emit' });
    } finally {
      nr.stop();
    }
  });
});

describe('DaemonNotificationRouter — M1 daemon-arbitrated events (source field)', () => {
  it('a source:"hook" event skips the hook-authority veto and still dispatches', async () => {
    // The pane IS hook-governed — by this very signal. Applying the veto to a
    // hook-sourced event would make every hook completion silent.
    const hookRouter = {
      recordDetector: vi.fn(),
      recordHook: vi.fn(),
      touchAuthority: vi.fn(),
      isGovernedFor: vi.fn().mockReturnValue(true),
      // #935: the status broadcast rides the same authority as the veto.
      governsDetectorStatus: vi.fn(
        (_p: string, slug: string | null | undefined, status: string) =>
          !!slug && (status === 'waiting' || status === 'complete'),
      ),
    } as unknown as HookSignalRouter;
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      dispatchNotificationMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Task finished',
          source: 'hook',
          hookKind: 'agent.stop',
        },
      });
      await flushMicrotasks();

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const events = pollLifecycle();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'agent.stop', source: 'hook', decision: 'emit' });
    } finally {
      nr.stop();
    }
  });

  it('never writes main\'s dedup ledger for an arbitrated event (hook or detector)', async () => {
    const hookRouter = stubHookRouter('dedup');
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'complete', message: 'done', source: 'detector' },
      });
      await flushMicrotasks();

      expect(hookRouter.recordDetector).not.toHaveBeenCalled();
      expect(pollLifecycle()[0]).toMatchObject({ source: 'detector', decision: 'emit' });
    } finally {
      nr.stop();
    }
  });

  it('carries hookKind through so agent.subagent_stop survives the trip', async () => {
    // The detector's status vocabulary cannot express a subagent turn; only the
    // hook can, and the renderer mutes on that distinction (#516).
    const { router: nr, captured } = makeRouter();
    try {
      dispatchNotificationMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Subagent finished',
          source: 'hook',
          hookKind: 'agent.subagent_stop',
        },
      });
      await flushMicrotasks();

      expect(pollLifecycle()[0]).toMatchObject({ kind: 'agent.subagent_stop', source: 'hook' });
      expect(dispatchNotificationMock.mock.calls[0][2]).toMatchObject({ category: 'subagent' });
    } finally {
      nr.stop();
    }
  });

  it('#935 decision:"veto" withholds the lifecycle status too — no dot, no toast, no tee', async () => {
    // The daemon applied the hook-authority rule main used to apply locally.
    // It used to leave the status dot live, which put the detector's reading
    // of Claude's always-visible bypass footer onto the roster row and into
    // "N need you" while the agent was still working. The hook owns lifecycle
    // on a vetoed event; identity still rides the broadcast.
    const hookRouter = stubHookRouter('emit');
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      dispatchNotificationMock.mockClear();
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'done',
          source: 'detector',
          decision: 'veto',
        },
      });
      await flushMicrotasks();

      // Identity still broadcast, lifecycle status withheld.
      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toMatchObject({
        ptyId: 'pty-a',
        agentName: 'Claude Code',
      });
      const statusCalls = broadcastMetadataUpdateMock.mock.calls.filter(
        (c) => (c[1] as { agentStatus?: string }).agentStatus !== undefined,
      );
      expect(statusCalls).toHaveLength(0);
      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(pollLifecycle()).toHaveLength(0);
      expect(hookRouter.recordDetector).not.toHaveBeenCalled();
    } finally {
      nr.stop();
    }
  });

  it('decision:"internal" is treated exactly like veto — dot only, no toast, no tee', async () => {
    // The daemon's CompletionAlarm rejected the candidate as NOT a real turn
    // end (subagent stop, leftover background work, turn-gate miss, already
    // announced, or a rebutted window). Main must not fan anything out.
    const hookRouter = stubHookRouter('emit');
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      dispatchNotificationMock.mockClear();
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'done',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'internal',
        },
      });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).toHaveBeenCalled(); // dot stays live
      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(pollLifecycle()).toHaveLength(0);
      expect(hookRouter.recordDetector).not.toHaveBeenCalled();
    } finally {
      nr.stop();
    }
  });

  it('decision:"dedup" tees the event but suppresses the second toast', async () => {
    const { router: nr, captured } = makeRouter();
    try {
      dispatchNotificationMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'done',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'dedup',
        },
      });
      await flushMicrotasks();

      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(pollLifecycle()[0]).toMatchObject({ source: 'hook', decision: 'dedup' });
    } finally {
      nr.stop();
    }
  });

  it('a stamped event with no decision emits (daemon could not arbitrate)', async () => {
    const { router: nr, captured } = makeRouter();
    try {
      dispatchNotificationMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'waiting', message: 'Ready', source: 'detector' },
      });
      await flushMicrotasks();

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      expect(pollLifecycle()[0]).toMatchObject({ source: 'detector', decision: 'emit' });
    } finally {
      nr.stop();
    }
  });

  it('an event WITHOUT source keeps the pre-M1 behavior (veto + ledger write)', async () => {
    const hookRouter = {
      recordDetector: vi.fn().mockReturnValue('emit'),
      recordHook: vi.fn(),
      touchAuthority: vi.fn(),
      isGovernedFor: vi.fn().mockReturnValue(true),
      // #935: the status broadcast rides the same authority as the veto.
      governsDetectorStatus: vi.fn(
        (_p: string, slug: string | null | undefined, status: string) =>
          !!slug && (status === 'waiting' || status === 'complete'),
      ),
    } as unknown as HookSignalRouter;
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'complete', message: 'done' },
      });
      await flushMicrotasks();

      expect(vi.mocked(hookRouter.isGovernedFor)).toHaveBeenCalledWith('pty-a', 'claude');
      expect(hookRouter.recordDetector).not.toHaveBeenCalled(); // vetoed
      expect(pollLifecycle()).toHaveLength(0);
    } finally {
      nr.stop();
    }
  });

  it('an unrecognized source value is treated as un-arbitrated (fails closed to the old path)', async () => {
    const hookRouter = stubHookRouter('emit');
    const { router: nr, captured } = makeRouter({ hookRouter });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'complete', message: 'done', source: 'bogus' },
      });
      await flushMicrotasks();

      expect(hookRouter.recordDetector).toHaveBeenCalledWith('claude', 'agent.stop', 'pty-a');
      expect(pollLifecycle()[0]).toMatchObject({ source: 'detector' });
    } finally {
      nr.stop();
    }
  });
});

describe('DaemonNotificationRouter — M1 side-effect replay', () => {
  // The envelope the daemon ships back on hook-sourced events. Main replays the
  // side effects its own hooks.signal handler used to run from its copy.
  function hookSignal(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'agent.stop',
      agent: 'claude',
      cwd: '/repo',
      payload: {},
      ts: 1_700_000_000_000,
      ...overrides,
    };
  }

  function activityEvent(toolName: string) {
    return {
      agent: 'Claude Code',
      status: 'running',
      message: '',
      source: 'hook',
      hookKind: 'agent.activity',
      decision: 'activity',
      signal: hookSignal({
        kind: 'agent.activity',
        payload: { tool_name: toolName, tool_input: {} },
      }),
    };
  }

  it('activity events feed the Fleet View line and nothing else', async () => {
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      dispatchNotificationMock.mockClear();
      captured.agent!({ sessionId: 'pty-a', event: activityEvent('Read') });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toEqual({
        ptyId: 'pty-a',
        activity: expect.stringContaining('Read'),
      });
      // No toast, no lifecycle tee, and no agentStatus broadcast — a tool-heavy
      // turn must not produce IPC per tool call.
      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(pollLifecycle()).toHaveLength(0);
    } finally {
      router.stop();
    }
  });

  it('throttles the activity line per pane (leading edge)', async () => {
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({ sessionId: 'pty-a', event: activityEvent('Read') });
      captured.agent!({ sessionId: 'pty-a', event: activityEvent('Edit') });
      captured.agent!({ sessionId: 'pty-b', event: activityEvent('Bash') });
      await flushMicrotasks();

      // pty-a's second call is inside the window; pty-b is a different key.
      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(2);
      const ptyIds = broadcastMetadataUpdateMock.mock.calls.map((c) => (c[1] as { ptyId: string }).ptyId);
      expect(ptyIds).toEqual(['pty-a', 'pty-b']);
    } finally {
      router.stop();
    }
  });

  it('drops an activity event that carries no envelope', async () => {
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      const { signal: _omitted, ...noSignal } = activityEvent('Read');
      captured.agent!({ sessionId: 'pty-a', event: noSignal });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).not.toHaveBeenCalled();
    } finally {
      router.stop();
    }
  });

  function sessionStartEvent(withSignal = true) {
    return {
      agent: 'Claude Code',
      status: 'running',
      message: '',
      source: 'hook',
      hookKind: 'agent.session_start',
      decision: 'activity',
      ...(withSignal ? { signal: hookSignal({ kind: 'agent.session_start' }) } : {}),
    };
  }

  it('session_start clears BOTH the activity line and the pending question', async () => {
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      dispatchNotificationMock.mockClear();
      captured.agent!({ sessionId: 'pty-a', event: sessionStartEvent() });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toEqual({
        ptyId: 'pty-a',
        activity: '',
        pendingQuestion: '',
      });
      // Still metadata-only: no toast, no lifecycle tee.
      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(pollLifecycle()).toHaveLength(0);
    } finally {
      router.stop();
    }
  });

  it('session_start is NEVER throttle-dropped behind a recent activity event', async () => {
    // A dropped clear would leave the previous session's tool label on a
    // brand-new session — the exact failure the bypass exists to prevent.
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({ sessionId: 'pty-a', event: activityEvent('Read') });
      captured.agent!({ sessionId: 'pty-a', event: sessionStartEvent() });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(2);
      expect(broadcastMetadataUpdateMock.mock.calls[1][1]).toEqual({
        ptyId: 'pty-a',
        activity: '',
        pendingQuestion: '',
      });
    } finally {
      router.stop();
    }
  });

  it('session_start clears even when the event carries no envelope', async () => {
    // The clear is derived from the KIND, so it must not depend on `signal`.
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({ sessionId: 'pty-a', event: sessionStartEvent(false) });
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
      expect(broadcastMetadataUpdateMock.mock.calls[0][1]).toMatchObject({
        activity: '',
        pendingQuestion: '',
      });
    } finally {
      router.stop();
    }
  });

  it('session_start leaves the activity throttle window untouched (documented choice)', async () => {
    // It neither stamps nor resets the window: the throttle keeps running off
    // the previous session's last tool call, so the next activity event is still
    // suppressed. The pane shows an EMPTY line in that gap (the clear just ran),
    // never a stale one — a sub-window delay on the first label, never wrong data.
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({ sessionId: 'pty-a', event: activityEvent('Read') });   // stamps
      captured.agent!({ sessionId: 'pty-a', event: sessionStartEvent() });     // clear
      captured.agent!({ sessionId: 'pty-a', event: activityEvent('Edit') });   // suppressed
      await flushMicrotasks();

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(2);
      const fields = broadcastMetadataUpdateMock.mock.calls.map((c) => c[1] as Record<string, unknown>);
      expect(fields[0]).toMatchObject({ activity: expect.stringContaining('Read') });
      expect(fields[1]).toMatchObject({ pendingQuestion: '' });
    } finally {
      router.stop();
    }
  });

  it('replays turn-boundary metadata, lastMessage and the turn-end probe on a hook stop', async () => {
    readLastAssistantMessageMock.mockReturnValue({
      text: 'Should I proceed?',
      endsWithQuestion: true,
    });
    const onClaudeTurnEnd = vi.fn();
    const { router, captured } = makeRouter({ onClaudeTurnEnd });
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Task finished',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'emit',
          signal: hookSignal({ payload: { transcript_path: '/t/session.jsonl' } }),
        },
      });
      await flushMicrotasks();

      expect(readLastAssistantMessageMock).toHaveBeenCalledWith('/t/session.jsonl');
      // Boundary patch rides ONE broadcast alongside the status one.
      const boundary = broadcastMetadataUpdateMock.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => 'pendingQuestion' in p);
      expect(boundary).toEqual({
        ptyId: 'pty-a',
        activity: '',
        pendingQuestion: 'Should I proceed?',
        agentStatus: 'complete',
      });
      expect(pollLifecycle()[0]).toMatchObject({
        source: 'hook',
        kind: 'agent.stop',
        lastMessage: { text: 'Should I proceed?', endsWithQuestion: true },
      });
      expect(onClaudeTurnEnd).toHaveBeenCalledExactlyOnceWith('ws-1');
    } finally {
      router.stop();
    }
  });

  it('a stop that asks nothing clears the pending question', async () => {
    readLastAssistantMessageMock.mockReturnValue({ text: 'All done.', endsWithQuestion: false });
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Task finished',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'emit',
          signal: hookSignal({ payload: { transcript_path: '/t/session.jsonl' } }),
        },
      });
      await flushMicrotasks();

      const boundary = broadcastMetadataUpdateMock.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => 'pendingQuestion' in p);
      expect(boundary).toMatchObject({ pendingQuestion: '' });
    } finally {
      router.stop();
    }
  });

  it('fires the turn-end probe on a dedup verdict too (the turn still ended)', async () => {
    const onClaudeTurnEnd = vi.fn();
    const { router, captured } = makeRouter({ onClaudeTurnEnd });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Task finished',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'dedup',
          signal: hookSignal(),
        },
      });
      await flushMicrotasks();

      expect(onClaudeTurnEnd).toHaveBeenCalledExactlyOnceWith('ws-1');
    } finally {
      router.stop();
    }
  });

  it('does not read a transcript or probe usage for a non-claude agent', async () => {
    const onClaudeTurnEnd = vi.fn();
    const { router, captured } = makeRouter({ onClaudeTurnEnd });
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'OpenCode',
          status: 'complete',
          message: 'Task finished',
          source: 'hook',
          hookKind: 'agent.stop',
          decision: 'emit',
          signal: hookSignal({ agent: 'opencode', payload: { transcript_path: '/t/x.jsonl' } }),
        },
      });
      await flushMicrotasks();

      expect(readLastAssistantMessageMock).not.toHaveBeenCalled();
      expect(onClaudeTurnEnd).not.toHaveBeenCalled();
      // The boundary itself is agent-agnostic and still fires.
      const boundary = broadcastMetadataUpdateMock.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => 'pendingQuestion' in p);
      expect(boundary).toMatchObject({ activity: '', agentStatus: 'complete' });
    } finally {
      router.stop();
    }
  });

  it('subagent_stop does NOT clear the activity line (parent turn continues)', async () => {
    const { router, captured } = makeRouter();
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'complete',
          message: 'Subagent finished',
          source: 'hook',
          hookKind: 'agent.subagent_stop',
          decision: 'emit',
          signal: hookSignal({ kind: 'agent.subagent_stop' }),
        },
      });
      await flushMicrotasks();

      const boundary = broadcastMetadataUpdateMock.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => 'pendingQuestion' in p);
      expect(boundary).toBeUndefined();
    } finally {
      router.stop();
    }
  });

  it('a detector-sourced arbitrated event replays nothing (it carries no envelope)', async () => {
    const onClaudeTurnEnd = vi.fn();
    const { router, captured } = makeRouter({ onClaudeTurnEnd });
    try {
      broadcastMetadataUpdateMock.mockClear();
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'complete', message: 'done', source: 'detector', decision: 'emit' },
      });
      await flushMicrotasks();

      const boundary = broadcastMetadataUpdateMock.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => 'pendingQuestion' in p);
      expect(boundary).toBeUndefined();
      expect(onClaudeTurnEnd).not.toHaveBeenCalled();
      expect(readLastAssistantMessageMock).not.toHaveBeenCalled();
      // The tee still fires — only the hook-only side effects are skipped.
      expect(pollLifecycle()[0]).toMatchObject({ source: 'detector' });
    } finally {
      router.stop();
    }
  });

  // A turn that ends on an API error reaches main as status 'error' with
  // hookKind 'agent.stop_failure'. It used to fall outside the emit-class
  // status list entirely, so nothing fired at all.
  describe('agent.stop_failure replay', () => {
    function failureEvent() {
      return {
        sessionId: 'pty-a',
        event: {
          agent: 'Claude Code',
          status: 'error',
          message: 'Turn failed (API error)',
          source: 'hook',
          hookKind: 'agent.stop_failure',
          decision: 'emit',
          signal: {
            kind: 'agent.stop_failure',
            agent: 'claude',
            cwd: '/repo',
            payload: {},
            ts: 1,
          },
        },
      };
    }

    it('paints the pane error, clears the stale activity label, and toasts', async () => {
      const { router: nr, captured } = makeRouter();
      try {
        dispatchNotificationMock.mockClear();
        broadcastMetadataUpdateMock.mockClear();
        captured.agent!(failureEvent());
        await flushMicrotasks();

        const patches = broadcastMetadataUpdateMock.mock.calls
          .map((c) => c[1] as Record<string, unknown>);
        expect(patches.some((p) => p.agentStatus === 'error')).toBe(true);
        // Never 'complete' — the turn finished nothing.
        expect(patches.some((p) => p.agentStatus === 'complete')).toBe(false);
        // The turn boundary clears the stale tool label, exactly as a stop does.
        expect(patches.some((p) => p.activity === '')).toBe(true);

        expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
        const [, , notification] = dispatchNotificationMock.mock.calls[0];
        expect(notification).toMatchObject({
          title: 'Claude Code: Turn failed (API error)',
          body: 'The turn ended on an API error',
          category: 'agent-turn',
        });
      } finally {
        nr.stop();
      }
    });

    it('emits no agent.lifecycle event for it', async () => {
      // `lifecycleKindFor` would fall through to 'agent.stop', which tells an
      // orchestrator the turn finished normally. Silence is the lesser wrong
      // until the published kind union is widened deliberately.
      const { router: nr, captured } = makeRouter();
      try {
        captured.agent!(failureEvent());
        await flushMicrotasks();
        expect(pollLifecycle()).toHaveLength(0);
      } finally {
        nr.stop();
      }
    });
  });
});

describe('DaemonNotificationRouter — osc133 lifecycle tee', () => {
  it('emits source:"osc133" on session:prompt with type:"command_end" and exitCode 0', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.prompt!({
        sessionId: 'pty-a',
        event: { type: 'command_end', ts: 1000, byteOffset: 42, exitCode: 0 },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        type: 'agent.lifecycle',
        workspaceId: 'ws-1',
        ptyId: 'pty-a',
        kind: 'agent.stop',
        source: 'osc133',
        agent: null,
        decision: 'emit',
        exitCode: 0,
      });
    } finally {
      router.stop();
    }
  });

  it('emits exitCode null when command_end omits an exit code', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.prompt!({
        sessionId: 'pty-a',
        event: { type: 'command_end', ts: 1000, byteOffset: 42 },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      expect(events[0]).toMatchObject({ source: 'osc133', exitCode: null });
    } finally {
      router.stop();
    }
  });

  it('ignores prompt_start / prompt_end / command_start (D-only emit)', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.prompt!({ sessionId: 'pty-a', event: { type: 'prompt_start', ts: 1, byteOffset: 0 } });
      captured.prompt!({ sessionId: 'pty-a', event: { type: 'command_start', ts: 2, byteOffset: 5 } });
      await flushMicrotasks();

      expect(pollLifecycle()).toHaveLength(0);
    } finally {
      router.stop();
    }
  });

  it('attaches the cached agent slug when a session:agent was seen first', async () => {
    const { router, captured } = makeRouter();
    try {
      // First an agent event populates the lastAgentNameByPty cache.
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'running', message: 'Working' },
      });
      await flushMicrotasks();
      eventBus.reset(); // Drop the implicit detector emit; isolate osc133.

      captured.prompt!({
        sessionId: 'pty-a',
        event: { type: 'command_end', ts: 1000, byteOffset: 42, exitCode: 1 },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      expect(events[0]).toMatchObject({ source: 'osc133', agent: 'claude', exitCode: 1 });
    } finally {
      router.stop();
    }
  });

  it('osc133 bypasses HookSignalRouter — always decision:"emit"', async () => {
    const router = stubHookRouter('dedup');
    const { router: nr, captured } = makeRouter({ hookRouter: router });
    try {
      captured.prompt!({
        sessionId: 'pty-a',
        event: { type: 'command_end', ts: 1000, byteOffset: 42, exitCode: 0 },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      expect(events[0]).toMatchObject({ source: 'osc133', decision: 'emit' });
      // recordDetector must NOT be called for osc133 — it's shell command
      // lifecycle, not agent-turn boundaries.
      expect(router.recordDetector).not.toHaveBeenCalled();
    } finally {
      nr.stop();
    }
  });

  it('session:died clears the cached agent slug so subsequent osc133 emits null', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'running', message: 'Working' },
      });
      await flushMicrotasks();
      captured.died!({ sessionId: 'pty-a' });

      eventBus.reset();
      captured.prompt!({
        sessionId: 'pty-a',
        event: { type: 'command_end', ts: 1000, byteOffset: 42, exitCode: 0 },
      });
      await flushMicrotasks();

      const events = pollLifecycle();
      expect(events[0]).toMatchObject({ source: 'osc133', agent: null });
    } finally {
      router.stop();
    }
  });

  it('snapshots the cached agent slug BEFORE awaiting workspace.list (race fix)', async () => {
    // Codex round-2 P2 — shell may emit OSC 133;D and then redraw the
    // prompt, which fires a session:agent burst, all while the OSC 133
    // tee is mid-await on workspace.list. If the slug were read AFTER
    // the await it would reflect the new turn's agent, mis-attributing
    // the just-completed command. PTYBridge local-mode snapshots
    // `agentDetector.getLastAgent()` synchronously before any await;
    // daemon-mode must match.
    let resolveWorkspaceListRpc: (value: typeof FIXTURE_WORKSPACE_LIST) => void = () => {};
    sendToRendererMock.mockImplementationOnce(
      () => new Promise((res) => { resolveWorkspaceListRpc = res; }),
    );

    const { router, captured } = makeRouter();
    try {
      // Seed the cache with Claude (running is metadata-only — does NOT
      // trigger emitDetectorLifecycle, so sendToRenderer is NOT consumed).
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Claude Code', status: 'running', message: 'Working' },
      });

      // OSC 133;D arrives — emitOsc133Lifecycle captures 'Claude Code'
      // synchronously, then awaits the mocked workspace.list above.
      captured.prompt!({
        sessionId: 'pty-a',
        event: { type: 'command_end', ts: 1000, byteOffset: 42, exitCode: 0 },
      });

      // While the await is pending, the shell redraws and a new agent
      // gate fires — the cache flips to Codex CLI.
      captured.agent!({
        sessionId: 'pty-a',
        event: { agent: 'Codex CLI', status: 'running', message: 'Working' },
      });

      // Now resolve the workspace.list RPC; the OSC 133 emit completes.
      resolveWorkspaceListRpc(FIXTURE_WORKSPACE_LIST);
      await flushMicrotasks();

      const osc = pollLifecycle().find(
        (e) => e.type === 'agent.lifecycle' && (e as { source?: string }).source === 'osc133',
      );
      // Must be 'claude' — the slug snapshot at command_end time, NOT
      // 'codex' which the cache now holds.
      expect(osc).toMatchObject({ source: 'osc133', agent: 'claude' });
    } finally {
      router.stop();
    }
  });
});
