// Regression: #733 — a finished pane stayed `running` forever.
//
// `session:idle` is the ONLY path that clears a plain shell's status back to
// `idle`: AgentDetector never matches a bare PowerShell/bash, so no
// `session:agent` ever arrives. That clear used to sit behind
// `recentlySuppressed()`, a 30s window built for a notification that had
// already been deleted. A workspace switch (pty:resize) inside the window made
// the handler drop the clear, and ActivityMonitor consumes its transition
// BEFORE invoking callbacks, so nothing ever retried. The pane reported
// `running` at an idle prompt until it was closed.
//
// ── Why this file does not mock idleSuppression ──────────────────────────────
// Four existing suites stub it with `recentlySuppressed: () => false`, which is
// exactly why 9251 unit tests stayed green through this bug: the branch that
// wedges a pane was never executed. These tests drive the REAL module — they
// call `markResize()` the way pty.handler does — so a future guard reintroduced
// in front of the status clear fails here instead of shipping.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
}));

vi.mock('../dispatchNotification', () => ({
  dispatchNotification: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

import { broadcastMetadataUpdate } from '../../ipc/handlers/metadata.handler';
import { markResize, clearPty } from '../idleSuppression';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const broadcastMetadataUpdateMock = vi.mocked(broadcastMetadataUpdate);

const PTY = 'daemon-plain-shell';

interface Captured {
  idle?: (payload: { sessionId: string }) => void;
  agent?: (payload: { sessionId: string; event: unknown }) => void;
  active?: (payload: { sessionId: string; agentName?: string }) => void;
}

function makeRouter() {
  const captured: Captured = {};
  const fakeDaemon = {
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      if (event === 'session:idle') captured.idle = cb as Captured['idle'];
      if (event === 'session:agent') captured.agent = cb as Captured['agent'];
      if (event === 'session:active') captured.active = cb as Captured['active'];
    }),
    off: vi.fn(),
  } as unknown as DaemonClient;
  const router = new DaemonNotificationRouter(fakeDaemon, () => null);
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

/** Did the handler broadcast the status clear for this pane? */
function clearedIdle(): boolean {
  return broadcastMetadataUpdateMock.mock.calls.some(
    ([, patch]) =>
      (patch as { ptyId?: string; agentStatus?: string }).ptyId === PTY &&
      (patch as { agentStatus?: string }).agentStatus === 'idle',
  );
}

describe('DaemonNotificationRouter status clear (#733)', () => {
  beforeEach(() => {
    broadcastMetadataUpdateMock.mockClear();
    // Module-global maps — isolate every case.
    clearPty(PTY);
  });

  afterEach(() => {
    clearPty(PTY);
    vi.useRealTimers();
  });

  it('clears a quiet pane to idle when nothing has happened', () => {
    const { router, captured } = makeRouter();
    captured.idle?.({ sessionId: PTY });
    expect(clearedIdle()).toBe(true);
    router.stop();
  });

  it('still clears when a resize just happened — the #733 wedge', () => {
    const { router, captured } = makeRouter();
    // What a workspace switch does, through the same entry point pty.handler
    // uses. Before the fix this made the clear vanish for good.
    markResize(PTY);
    captured.idle?.({ sessionId: PTY });
    expect(clearedIdle()).toBe(true);
    router.stop();
  });

  it('still clears long after a resize, so the pane cannot wedge', () => {
    vi.useFakeTimers();
    const { router, captured } = makeRouter();
    markResize(PTY);
    // Comfortably inside the window the old guard used (30s).
    vi.advanceTimersByTime(5_000);
    captured.idle?.({ sessionId: PTY });
    expect(clearedIdle()).toBe(true);
    router.stop();
  });

  it('defers to a recent precise agent status instead of overwriting it', () => {
    const { router, captured } = makeRouter();
    // A real waiting/complete signal outranks byte silence — this protection
    // is deliberately kept, so agent panes do not flip to idle mid-turn.
    captured.agent?.({
      sessionId: PTY,
      event: { agent: 'Claude Code', status: 'waiting', message: 'Ready' },
    });
    broadcastMetadataUpdateMock.mockClear();
    captured.idle?.({ sessionId: PTY });
    expect(clearedIdle()).toBe(false);
    router.stop();
  });

  it('#935 direction 3 — still clears when a burst overwrote the precise status with running', () => {
    // The wedge: a precise 'complete' lands, then a short burst inside the
    // suppression window re-fires session:active ('running') on top of it —
    // exactly what a final chrome repaint or keystroke echo does. Byte
    // silence never returns because the pane really is done, so onIdle is the
    // ONLY thing that can still self-heal this. Before the fix it deferred to
    // the (no longer true) precise status and left the pane wedged forever.
    const { router, captured } = makeRouter();
    captured.agent?.({
      sessionId: PTY,
      event: { agent: 'Claude Code', status: 'complete', message: 'Done' },
    });
    expect(lastStatus()).toBe('complete');
    captured.active?.({ sessionId: PTY, agentName: 'Claude Code' });
    expect(lastStatus()).toBe('running');
    broadcastMetadataUpdateMock.mockClear();
    captured.idle?.({ sessionId: PTY }); // still inside AGENT_EVENT_SUPPRESSION_MS
    expect(clearedIdle()).toBe(true);
    router.stop();
  });
});
