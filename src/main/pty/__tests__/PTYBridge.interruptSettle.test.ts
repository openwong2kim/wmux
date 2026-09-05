// The INTERRUPT edge. Live finding (Claude Code 2.1.236): the operator stops a
// running turn with Ctrl+C (or ESC ESC), Claude prints "Interrupted · What
// should Claude do instead?" and returns to its prompt — but fires NO Stop
// hook, and the `claude` process is still the pane's foreground command, so
// OSC 133 never reports the shell back at its prompt either. Both existing
// settle edges are blind, and the turn latch held the pane amber ("Running" in
// the roster) until its 30-minute expiry.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
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

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: vi.fn(),
  removeCwd: vi.fn(),
  updateBranch: vi.fn(),
  removeBranch: vi.fn(),
  broadcastMetadataUpdate: mocks.broadcastMetadataUpdate,
  getLastBroadcastAgentStatus: (ptyId: string) => mocks.lastBroadcastAgentStatus.get(ptyId),
  clearLastBroadcastAgentStatus: (ptyId: string) => { mocks.lastBroadcastAgentStatus.delete(ptyId); },
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { SignalLatencyMeter } from '../../../shared/hooks/SignalLatencyMeter';
import { clearPty as clearSuppression, SETTLE_REDRAW_GUARD_MS } from '../../notification/idleSuppression';

interface MockProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number }) => void) => void;
  emitData: (data: string) => void;
}

function makeMockProcess(): MockProcess {
  let dataCb: ((data: string) => void) | null = null;
  return {
    onData: (cb) => { dataCb = cb; },
    onExit: () => undefined,
    emitData: (d) => { dataCb?.(d); },
  };
}

function makeBridge() {
  const proc = makeMockProcess();
  const instance: PTYInstance = {
    id: 'p1',
    process: proc as unknown as PTYInstance['process'],
    shell: 'bash',
  };
  const manager = {
    get: vi.fn(() => instance),
    remove: vi.fn(),
    onDispose: vi.fn(),
  } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const router = new HookSignalRouter({ latencyMeter: new SignalLatencyMeter() });
  const bridge = new PTYBridge(manager, () => win as never, () => router);
  return { bridge, router, proc };
}

function idleBroadcasts(ptyId: string): number {
  return mocks.broadcastMetadataUpdate.mock.calls.filter(
    (c) => (c[1] as { ptyId?: string }).ptyId === ptyId
      && (c[1] as { agentStatus?: string }).agentStatus === 'idle',
  ).length;
}

describe('PTYBridge interrupt edge (Ctrl+C / ESC ESC settles a latched pane)', () => {
  beforeEach(() => {
    mocks.broadcastMetadataUpdate.mockClear();
    mocks.lastBroadcastAgentStatus.clear();
  });

  it('releases the latch and broadcasts idle on 0x03', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');
    expect(router.governsRunningState('p1')).toBe(true);

    bridge.noteInterruptInput('p1', '\x03');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(1);
  });

  it('leaves an unlatched pane alone — a plain shell Ctrl+C broadcasts nothing', () => {
    const { bridge } = makeBridge();

    bridge.noteInterruptInput('p1', '\x03');

    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('ignores a lone ESC (arrow keys and CSI reports start with one)', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x1b');
    bridge.noteInterruptInput('p1', '\x1b[A');

    expect(router.governsRunningState('p1')).toBe(true);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('releases the latch on ESC ESC', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x1b\x1b');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(1);
  });

  it('releases the latch on two consecutive lone ESC chunks', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x1b');
    bridge.noteInterruptInput('p1', '\x1b');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(1);
  });

  it('withholds the broadcast (but still releases) when the pane holds an unread result', () => {
    const { bridge, router } = makeBridge();
    // The F5 guard, shared with the OSC 133 settle: an interrupt does not
    // un-finish a turn whose result the operator has not read yet.
    mocks.lastBroadcastAgentStatus.set('p1', 'awaiting_input');
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x03');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(0);
  });

});

function runningBroadcasts(ptyId: string): number {
  return mocks.broadcastMetadataUpdate.mock.calls.filter(
    (c) => (c[1] as { ptyId?: string }).ptyId === ptyId
      && (c[1] as { agentStatus?: string }).agentStatus === 'running',
  ).length;
}

describe('PTYBridge settle-redraw guard (the burst that follows a settle)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.broadcastMetadataUpdate.mockClear();
    mocks.lastBroadcastAgentStatus.clear();
    clearSuppression('p1');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** >2000 bytes crosses ActivityMonitor.ACTIVE_THRESHOLD and fires onActive. */
  function burst(proc: MockProcess) {
    proc.emitData('x'.repeat(3000));
    vi.advanceTimersByTime(50); // flush the 8ms micro-batch
  }

  it('swallows the byte "running" for the redraw right after a settle', () => {
    const { bridge, router, proc } = makeBridge();
    bridge.setupDataForwarding('p1');
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x03');
    mocks.broadcastMetadataUpdate.mockClear();
    // Claude's answer to Ctrl+C: "Interrupted · What should Claude do instead?"
    // plus a full prompt repaint — several KB, indistinguishable from work.
    burst(proc);

    expect(runningBroadcasts('p1')).toBe(0);
  });

  it('broadcasts byte "running" again once the guard window has passed', () => {
    const { bridge, router, proc } = makeBridge();
    bridge.setupDataForwarding('p1');
    router.noteHookTurnStart('p1', Date.now(), 'claude');
    bridge.noteInterruptInput('p1', '\x03');

    // Past the guard, and past ActivityMonitor's idle delay so onActive re-arms.
    vi.advanceTimersByTime(SETTLE_REDRAW_GUARD_MS + 5_100);
    mocks.broadcastMetadataUpdate.mockClear();
    burst(proc);

    expect(runningBroadcasts('p1')).toBe(1);
  });

  it('leaves an unsettled pane alone — byte "running" broadcasts as before', () => {
    const { bridge, proc } = makeBridge();
    bridge.setupDataForwarding('p1');

    burst(proc);

    expect(runningBroadcasts('p1')).toBe(1);
  });
});
