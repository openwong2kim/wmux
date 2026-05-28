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
}));

vi.mock('../sendNotification', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../idleSuppression', () => ({
  recentlySuppressed: vi.fn().mockReturnValue(false),
  clearPty: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const sendToRendererMock = vi.mocked(sendToRenderer);

const FIXTURE_WORKSPACE_LIST = [
  { id: 'ws-1', name: 'Workspace 1', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] },
];

interface CapturedListeners {
  agent?: (payload: { sessionId: string; event: unknown }) => void;
  prompt?: (payload: { sessionId: string; event: unknown }) => void;
  died?: (payload: { sessionId: string }) => void;
}

function makeRouter(opts: { hookRouter?: HookSignalRouter | null } = {}) {
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
  const router = new DaemonNotificationRouter(fakeDaemon, () => null, getHookRouter);
  router.start();
  return { router, captured };
}

function stubHookRouter(decision: 'emit' | 'dedup'): HookSignalRouter {
  return {
    recordDetector: vi.fn().mockReturnValue(decision),
    recordHook: vi.fn().mockReturnValue('emit'),
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
