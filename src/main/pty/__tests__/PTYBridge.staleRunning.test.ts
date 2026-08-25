// #935 direction 3 — "Running"-after-ended: a precise 'complete'/'waiting'
// status survives correctly until a short burst (a final chrome repaint, a
// keystroke echo) re-fires ActivityMonitor.onActive and overwrites it with
// 'running'. That burst is real, so the pane genuinely goes quiet afterward —
// but onActiveToIdle's suppression window used to defer to "a precise status
// landed recently", which was no longer true once 'running' clobbered it, and
// a quiet pane never produces another burst to re-fire the self-heal. The
// pane wedged at 'running' forever.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // Faithful stand-in for metadata.handler.ts's real funnel (#935 direction
  // 3): this test mocks the whole module, so the recording behavior has to
  // be reproduced here rather than inherited — a bare `vi.fn()` stub would
  // silently disconnect PTYBridge's deferral check from anything hooks.rpc
  // (simulated below) broadcasts, which is exactly the gap this suite exists
  // to catch.
  const lastBroadcastAgentStatus = new Map<string, string>();
  const broadcastMetadataUpdate = vi.fn(
    (_win: unknown, payload: { ptyId?: string; agentStatus?: string }) => {
      if (payload.ptyId && payload.agentStatus !== undefined) {
        lastBroadcastAgentStatus.set(payload.ptyId, payload.agentStatus);
      }
    },
  );
  return {
    toastManager: { show: vi.fn() },
    broadcastMetadataUpdate,
    sendNotification: vi.fn(),
    lastBroadcastAgentStatus,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: mocks.toastManager,
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

vi.mock('../../notification/sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock('../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

const broadcastMetadataUpdateMock = mocks.broadcastMetadataUpdate;

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';

interface MockProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number }) => void) => void;
  emitData: (data: string) => void;
}

function makeMockProcess(): MockProcess {
  let dataCb: ((data: string) => void) | null = null;
  return {
    onData: (cb) => { dataCb = cb; },
    // No-op: this fixture is never exercised through the exit path.
    onExit: () => undefined,
    emitData: (d) => { dataCb?.(d); },
  };
}

/**
 * @param hookRouter When set, the pane behaves as hook-governed: the
 * detector's own end-of-turn status is withheld from the broadcast, matching
 * a live Claude Code session under hooks.
 */
function makeBridge(hookRouter?: Pick<HookSignalRouter, 'governsDetectorStatus'>) {
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
  const bridge = new PTYBridge(
    manager,
    () => win as never,
    hookRouter ? (() => hookRouter as HookSignalRouter) : undefined,
  );
  bridge.setupDataForwarding('p1');
  return { bridge, proc };
}

function flushMicroBatch() {
  vi.advanceTimersByTime(50);
}

/** Last agentStatus broadcast for ptyId 'p1', or undefined if none yet. */
function lastStatus(): string | undefined {
  const calls = broadcastMetadataUpdateMock.mock.calls.filter(
    (c) => (c[1] as { ptyId?: string }).ptyId === 'p1',
  );
  return (calls.at(-1)?.[1] as { agentStatus?: string } | undefined)?.agentStatus;
}

function idleWasBroadcast(): boolean {
  return broadcastMetadataUpdateMock.mock.calls.some(
    (c) => (c[1] as { agentStatus?: string }).agentStatus === 'idle',
  );
}

describe('PTYBridge stale "running" after turn end (#935 direction 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    broadcastMetadataUpdateMock.mockClear();
    mocks.lastBroadcastAgentStatus.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('self-heals to idle even when a post-completion burst re-armed "running" inside the suppression window', () => {
    const { proc } = makeBridge();

    // Aider gate, then a precise 'complete' classification.
    proc.emitData('aider v1.2.3\n');
    proc.emitData('Applied edit to foo.py\n');
    flushMicroBatch();
    expect(lastStatus()).toBe('complete');

    // A short burst well inside AGENT_EVENT_SUPPRESSION_MS (10s) — a final
    // chrome repaint or keystroke echo, not a new turn. >2000 bytes crosses
    // ActivityMonitor.ACTIVE_THRESHOLD and fires onActive unconditionally.
    proc.emitData('x'.repeat(3000));
    flushMicroBatch();
    expect(lastStatus()).toBe('running');

    broadcastMetadataUpdateMock.mockClear();
    // 5s of complete byte silence (ActivityMonitor.IDLE_DELAY_MS) — the pane
    // really is done and produces nothing further, ever.
    vi.advanceTimersByTime(5_100);

    expect(idleWasBroadcast()).toBe(true);
  });

  it('still defers to a precise status that has not been overwritten (no regression on #733 protection)', () => {
    const { proc } = makeBridge();

    // A burst FIRST, so ActivityMonitor actually reaches active and later has
    // an active-to-idle transition to fire — without this, onActiveToIdle can
    // never run regardless of the suppression logic, and the assertion below
    // would pass even with the deferral check deleted entirely. (The bug this
    // reshape closes: the previous version of this test fed only a few dozen
    // bytes, below ACTIVE_THRESHOLD, so it asserted nothing.)
    proc.emitData('x'.repeat(3000));
    flushMicroBatch();
    expect(lastStatus()).toBe('running');

    // The precise 'complete' lands after the burst and is the last thing
    // broadcast — the suppression window is armed and the tracked status is
    // no longer 'running'.
    proc.emitData('aider v1.2.3\n');
    proc.emitData('Applied edit to foo.py\n');
    flushMicroBatch();
    expect(lastStatus()).toBe('complete');

    broadcastMetadataUpdateMock.mockClear();
    // No intervening burst — 'complete' is still the live status when the
    // idle fallback would otherwise fire. Must keep deferring to it.
    vi.advanceTimersByTime(5_100);

    expect(idleWasBroadcast()).toBe(false);
  });

  it('defers to a status the hooks path broadcast, not just what PTYBridge itself broadcast (hook-governed pane)', () => {
    // Hook-governed: the detector's own end-of-turn classification is
    // withheld from agentStatus (see PTYBridge's withholdStatus), so the
    // only precise 'complete' this pane will ever show comes from
    // hooks.rpc's Stop-hook broadcast, a call PTYBridge never makes and,
    // before the #935-direction-3 funnel, a map PTYBridge never saw.
    const { proc } = makeBridge({ governsDetectorStatus: () => true });

    // The detector still classifies this pane's own end-of-turn text — it is
    // withheld from the broadcast (governsDetectorStatus === true), so
    // lastStatus() stays undefined here, but classifying 'complete'/'waiting'
    // unconditionally arms lastAgentEventAt (PTYBridge.ts), which is what
    // keeps the suppression window below open long enough for the hook's own
    // broadcast, a few lines down, to land inside it.
    proc.emitData('aider v1.2.3\n');
    proc.emitData('Applied edit to foo.py\n');
    flushMicroBatch();
    expect(lastStatus()).toBeUndefined();

    // A burst re-fires onActive, an unconditional 'running', same as any pane.
    proc.emitData('x'.repeat(3000));
    flushMicroBatch();
    expect(lastStatus()).toBe('running');

    // Simulates hooks.rpc's turn-boundary broadcast (buildTurnBoundaryMetadata,
    // src/main/pipe/handlers/hooks.rpc.ts), an entirely separate call site
    // that, in production, funnels through the same broadcastMetadataUpdate
    // this file mocks. Landing here after the burst is the realistic
    // ordering: the burst is the turn's own trailing output, the Stop hook
    // fires once the turn is actually done.
    broadcastMetadataUpdateMock({ isDestroyed: () => false }, { ptyId: 'p1', agentStatus: 'complete' });

    broadcastMetadataUpdateMock.mockClear();
    vi.advanceTimersByTime(5_100);

    // Before the funnel fix, PTYBridge's own tracker never learned about the
    // hooks.rpc broadcast, stayed wedged at 'running' from the burst, and
    // this handler wiped the hook's 'complete' back to 'idle' five seconds
    // after every governed turn. With the funnel, the shared tracker reflects
    // the hook's broadcast and the deferral holds.
    expect(idleWasBroadcast()).toBe(false);
  });
});
