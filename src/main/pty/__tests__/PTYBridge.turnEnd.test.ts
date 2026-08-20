// #935 direction 2, local half — an authoritative turn end re-arms the pane's
// activity cycle so the NEXT turn can report `running` again.
//
// The local bridge is where the stuck cycle is REAL: unlike DaemonPTYBridge
// (whose explicit-terminal-status gate silences ActivityMonitor after a
// terminal status, letting the idle timer fire and self-re-arm), this bridge
// feeds the monitor ungated. A TUI painting a live elapsed-time counter every
// second keeps rescheduling the 5s idle timer forever, so onActive — which
// fires once per cycle — never re-arms, and the `complete` written at turn end
// survives the pane's whole next turn.
//
//   burst > 2KB      1s repaints (~100B)        un-vetoed detector      burst > 2KB
//   ────────────►    ─────────────────────►     terminal status  ───►  ────────────►
//   onActive fires   idle timer rescheduled     endTurn(ptyId)         onActive fires
//   ('running' #1)   forever — NO re-arm        cycle re-armed         ('running' #2)
//
// The regression case below fails on the pre-#943 bridge: without endTurn the
// second burst lands in the same stuck cycle and 'running' #2 never fires.
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

// See PTYBridge.lifecycle.test.ts for why this is needed — dispatchNotification's
// real implementation runs here, and its readiness gate defaults to false.
vi.mock('../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { eventBus } from '../../events/EventBus';

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

function stubHookRouter(opts: { governed?: boolean } = {}): HookSignalRouter {
  const governed = opts.governed ?? false;
  return {
    recordDetector: vi.fn().mockReturnValue('emit'),
    recordHook: vi.fn().mockReturnValue('emit'),
    touchAuthority: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(governed),
    // Mirrors the real predicate: only the two statuses the Stop hook speaks
    // for, and only on a governed pane (see PTYBridge.lifecycle.test.ts).
    governsDetectorStatus: vi.fn(
      (_ptyId: string, slug: string | null | undefined, status: string) =>
        governed && !!slug && (status === 'waiting' || status === 'complete'),
    ),
  } as unknown as HookSignalRouter;
}

function makeBridge(opts: { hookRouter?: HookSignalRouter } = {}) {
  const proc = makeMockProcess();
  const instance: PTYInstance = {
    id: 'pty-1',
    process: proc as unknown as PTYInstance['process'],
    shell: 'bash',
    workspaceId: 'ws-a',
  } as PTYInstance;
  const manager = makeMockManager(instance);
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const router = opts.hookRouter;
  const bridge = new PTYBridge(manager, () => win as never, router ? () => router : undefined);
  bridge.setupDataForwarding('pty-1');
  return { bridge, proc };
}

function runningBroadcasts(): number {
  return mocks.broadcastMetadataUpdate.mock.calls.filter(
    (call) => (call[1] as { agentStatus?: string }).agentStatus === 'running',
  ).length;
}

/** Advance past the 8ms batch interval so middlewares (monitor feed) run. */
function flush() {
  vi.advanceTimersByTime(50);
}

/**
 * The pinned TUI shape: per-second sub-threshold repaints (a live elapsed-time
 * counter). Each one reschedules the idle timer, so the cycle never idles out
 * on its own. ~100B/s stays far under the 2KB/3s active threshold.
 */
function repaintFor(proc: MockProcess, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    // Newline-terminated so the repaint noise cannot merge with a later
    // detector line inside AgentDetector's line buffer.
    proc.emitData(`${'x'.repeat(99)}\n`);
    vi.advanceTimersByTime(1000);
  }
}

describe('PTYBridge — turn end re-arms the activity cycle (#935 direction 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    eventBus.reset();
    mocks.broadcastMetadataUpdate.mockReset();
    mocks.sendNotification.mockReset();
    mocks.toastManager.show.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('REGRESSION: repaints never re-arm on their own; an un-vetoed detector turn end does', () => {
    const { proc } = makeBridge({ hookRouter: stubHookRouter() });

    // Turn 1: a real burst crosses the threshold → 'running' #1.
    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);

    // 30s of live-counter repaints: the idle timer keeps rescheduling, the
    // cycle stays active-and-already-fired, so no idle-out and no re-fire.
    repaintFor(proc, 30);
    expect(runningBroadcasts()).toBe(1);
    expect(
      mocks.broadcastMetadataUpdate.mock.calls.some(
        (call) => (call[1] as { agentStatus?: string }).agentStatus === 'idle',
      ),
    ).toBe(false);

    // Authoritative turn end on the detector path (ungoverned pane): Claude's
    // gate phrase, then the idle footer classifies as 'waiting'. (The banner
    // line also makes AgentDetector emit its own 'running' — that is the
    // detector's identity path, not the monitor's, so the discriminating
    // assertion below starts counting AFTER the turn end landed.)
    proc.emitData('Claude Code starting up\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();
    mocks.broadcastMetadataUpdate.mockClear();

    // Turn 2: the next genuine burst reports running again. Pre-#943 this
    // lands in the same stuck cycle and nothing fires here at all ('y'
    // matches no detector pattern, and the monitor's onActive is spent).
    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);
  });

  it('sub-threshold chrome after the turn end does NOT report running', () => {
    const { proc } = makeBridge({ hookRouter: stubHookRouter() });

    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);

    proc.emitData('Claude Code starting up\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    // endTurn re-arms the THRESHOLD path, not the first-byte path: idle
    // chrome after a turn end must stay inert (that is what keeps this from
    // making direction 3 — running-after-ended — worse).
    repaintFor(proc, 10);
    expect(runningBroadcasts()).toBe(1);
  });

  it('a hook-vetoed detector status does NOT re-arm the cycle', () => {
    const { proc } = makeBridge({ hookRouter: stubHookRouter({ governed: true }) });

    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);

    // Governed pane: the footer 'waiting' is mid-turn chrome (#939). It is
    // withheld from the roster AND must not act as a cycle boundary — the
    // hook's own Stop (via noteTurnEnd) is the real edge on this pane.
    proc.emitData('Claude Code starting up\n');
    proc.emitData('  shift+tab to cycle\n');
    flush();

    // Still the same stuck cycle: a burst cannot re-fire running.
    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);
  });

  it('noteTurnEnd re-arms the cycle from the hook seam (public method)', () => {
    const { bridge, proc } = makeBridge({ hookRouter: stubHookRouter({ governed: true }) });

    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);
    repaintFor(proc, 5);

    // The governed pane's real edge: the Stop hook, arriving via
    // hooks.rpc.ts → main/index.ts → noteTurnEnd.
    bridge.noteTurnEnd('pty-1');

    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(2);
  });

  it('noteTurnEnd for a pty this bridge does not own is a no-op', () => {
    const { bridge, proc } = makeBridge({ hookRouter: stubHookRouter() });
    expect(() => bridge.noteTurnEnd('daemon-owned-pane')).not.toThrow();
    // The owned pane's cycle is untouched.
    proc.emitData('y'.repeat(3000));
    flush();
    expect(runningBroadcasts()).toBe(1);
  });
});
