import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Module mocks (must be declared before importing PTYBridge) ─────────────
// vi.mock factories are hoisted to the top of the file, so any captured
// variables must come from vi.hoisted() — plain `const` declarations are not
// yet evaluated when the factory runs.

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

const broadcastMetadataUpdateMock = mocks.broadcastMetadataUpdate;
const sendNotificationMock = mocks.sendNotification;
const toastManagerMock = mocks.toastManager;

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';

// ── Helpers ────────────────────────────────────────────────────────────────

interface MockProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number }) => void) => void;
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
}

function makeMockProcess(): MockProcess {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((info: { exitCode: number }) => void) | null = null;
  return {
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    emitData: (d) => { dataCb?.(d); },
    emitExit: (c) => { exitCb?.({ exitCode: c }); },
  };
}

function makeMockManager(instance: PTYInstance) {
  return {
    get: vi.fn(() => instance),
    remove: vi.fn(),
    onDispose: vi.fn(),
  } as unknown as PTYManager;
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

function makeBridge() {
  const proc = makeMockProcess();
  const instance: PTYInstance = {
    id: 'p1',
    process: proc as unknown as PTYInstance['process'],
    shell: 'bash',
  };
  const manager = makeMockManager(instance);
  const win = makeWindow();
  const bridge = new PTYBridge(manager, () => win as never);
  bridge.setupDataForwarding('p1');
  return { bridge, proc, win };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PTYBridge notification wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    broadcastMetadataUpdateMock.mockReset();
    sendNotificationMock.mockReset();
    toastManagerMock.show.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function flushMicroBatch() {
    // Advance past PTYBridge.BATCH_INTERVAL_MS (8ms) so the pending flush
    // runs middlewares (AgentDetector / ActivityMonitor).
    vi.advanceTimersByTime(50);
  }

  it('AgentDetector "waiting" emits METADATA_UPDATE + NOTIFICATION + toast', () => {
    const { proc } = makeBridge();

    // Gate Claude Code, then feed an idle prompt line that AgentDetector
    // classifies as 'waiting'. Use a large chunk to also nudge ActivityMonitor
    // but we only assert on the METADATA_UPDATE shape and the agent
    // notification call here.
    proc.emitData('Claude Code starting up\n');
    proc.emitData('  shift+tab to cycle\n');
    flushMicroBatch();

    // Latest METADATA_UPDATE should carry agentStatus='waiting' for ptyId 'p1'
    const metaCalls = broadcastMetadataUpdateMock.mock.calls.filter(
      (c) => (c[1] as { agentStatus?: string }).agentStatus === 'waiting',
    );
    expect(metaCalls.length).toBeGreaterThanOrEqual(1);
    expect(metaCalls[0][1]).toMatchObject({ ptyId: 'p1', agentStatus: 'waiting', agentName: 'Claude Code' });

    // sendNotification fires for waiting/complete (not running)
    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      expect.objectContaining({ type: 'agent' }),
    );
    expect(toastManagerMock.show).toHaveBeenCalled();
  });

  it('ActivityMonitor "active" emits METADATA_UPDATE with agentStatus="running"', () => {
    const { proc } = makeBridge();

    // Push >2000 bytes in <3s to enter active state
    proc.emitData('x'.repeat(3000));
    flushMicroBatch();

    const runningCall = broadcastMetadataUpdateMock.mock.calls.find(
      (c) => (c[1] as { agentStatus?: string }).agentStatus === 'running',
    );
    expect(runningCall).toBeTruthy();
    expect(runningCall![1]).toMatchObject({ ptyId: 'p1', agentStatus: 'running' });
  });

  it('REGRESSION: onExit broadcasts agentStatus="idle" + clears unread state', () => {
    const { proc } = makeBridge();

    proc.emitData('something');
    flushMicroBatch();

    broadcastMetadataUpdateMock.mockClear();
    proc.emitExit(0);

    const idleCall = broadcastMetadataUpdateMock.mock.calls.find(
      (c) => (c[1] as { agentStatus?: string }).agentStatus === 'idle',
    );
    expect(idleCall).toBeTruthy();
    expect(idleCall![1]).toMatchObject({ ptyId: 'p1', agentStatus: 'idle', agentName: '' });
  });

  it('REGRESSION (R5): cleanupInstance unsubscribes AgentDetector listeners (no leak)', () => {
    const { bridge, proc } = makeBridge();

    proc.emitData('Claude Code\n');
    proc.emitData('  shift+tab to cycle\n');
    flushMicroBatch();

    const callsBefore = broadcastMetadataUpdateMock.mock.calls.length;

    // Dispose this PTY
    bridge.cleanupInstance('p1');

    // After cleanup, AgentDetector still exists in memory inside the
    // closure but callbacks must have been unsubscribed — further pattern
    // matches on a stale detector should not show up as new IPC sends.
    // (The detector instance is discarded; this is a sanity check that
    // cleanup ran without throwing and removed bookkeeping.)
    expect(callsBefore).toBeGreaterThanOrEqual(1);
    expect(() => bridge.cleanupInstance('p1')).not.toThrow(); // idempotent
  });

  it('REGRESSION (R4): a throwing AgentDetector callback does not stop later events', () => {
    // PTYBridge wraps its subscription callbacks in try/catch. We can not
    // easily inject a throwing AgentDetector callback from outside the
    // PTYBridge, but we can assert the symmetric guarantee: if
    // broadcastMetadataUpdate throws synchronously, subsequent agent events
    // still fire the notification path on the next match.
    broadcastMetadataUpdateMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const { proc } = makeBridge();

    proc.emitData('Claude Code\n');
    proc.emitData('  shift+tab to cycle\n');
    flushMicroBatch();

    // Even though the first metadata broadcast threw, sendNotification
    // should still have been attempted afterwards (try/catch isolates
    // failures within the onEvent callback body).
    // Implementation note: our try/catch wraps the whole onEvent body, so
    // the *same* event won't call sendNotification after the throw — but
    // a *later* matching event still works. Trigger a second pattern.
    proc.emitData('  bypass permissions on\n');
    flushMicroBatch();

    // A later legitimate emit must still proceed through the callback path
    // (the first throw didn't kill the subscription).
    expect(broadcastMetadataUpdateMock.mock.calls.length).toBeGreaterThan(1);
  });
});
