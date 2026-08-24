// #935 direction 3 — "Running"-after-ended: a precise 'complete'/'waiting'
// status survives correctly until a short burst (a final chrome repaint, a
// keystroke echo) re-fires ActivityMonitor.onActive and overwrites it with
// 'running'. That burst is real, so the pane genuinely goes quiet afterward —
// but onActiveToIdle's suppression window used to defer to "a precise status
// landed recently", which was no longer true once 'running' clobbered it, and
// a quiet pane never produces another burst to re-fire the self-heal. The
// pane wedged at 'running' forever.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toastManager: { show: vi.fn() },
  broadcastMetadataUpdate: vi.fn(),
  sendNotification: vi.fn(),
}));

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
  const bridge = new PTYBridge(manager, () => win as never);
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

describe('PTYBridge stale "running" after turn end (#935 direction 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    broadcastMetadataUpdateMock.mockReset();
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

    const idleCall = broadcastMetadataUpdateMock.mock.calls.find(
      (c) => (c[1] as { agentStatus?: string }).agentStatus === 'idle',
    );
    expect(idleCall).toBeTruthy();
    expect(idleCall![1]).toMatchObject({ ptyId: 'p1', agentStatus: 'idle' });
  });

  it('still defers to a precise status that has NOT been overwritten (no regression on #733\'s protection)', () => {
    const { proc } = makeBridge();

    proc.emitData('aider v1.2.3\n');
    proc.emitData('Applied edit to foo.py\n');
    flushMicroBatch();
    expect(lastStatus()).toBe('complete');

    broadcastMetadataUpdateMock.mockClear();
    // No intervening burst — 'complete' is still the live status when the
    // idle fallback would otherwise fire. Must keep deferring to it.
    vi.advanceTimersByTime(5_100);

    const idleCall = broadcastMetadataUpdateMock.mock.calls.find(
      (c) => (c[1] as { agentStatus?: string }).agentStatus === 'idle',
    );
    expect(idleCall).toBeUndefined();
  });
});
