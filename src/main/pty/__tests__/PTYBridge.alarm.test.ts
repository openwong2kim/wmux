// Verdict-gate tests for the PTYBridge detector path with a REAL
// CompletionAlarm injected (the 4th ctor param main wires). The scenarios
// locked here mirror hooks.rpc.alarm.test.ts on the hook side:
//   - running → waiting → window confirms → recordDetector at CONFIRM time
//     (R1), tee 'emit', toast once.
//   - a working cue inside the window (user input via noteUserInput, or a new
//     running detection) rebuts the candidate — no toast, no ledger write.
//   - a waiting candidate with no prior working evidence is rejected —
//     'internal' trace only, no toast.
//   - cleanupInstance cancels the pane's pending window.
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

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { eventBus } from '../../events/EventBus';
import { CompletionAlarm, DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';

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

function stubHookRouter(decision: 'emit' | 'dedup' = 'emit'): HookSignalRouter {
  return {
    recordDetector: vi.fn().mockReturnValue(decision),
    recordHook: vi.fn().mockReturnValue('emit'),
    touchAuthority: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(false),
    governsDetectorStatus: vi.fn().mockReturnValue(false),
  } as unknown as HookSignalRouter;
}

function makeRig(opts: { hookRouter?: HookSignalRouter } = {}) {
  const proc = makeMockProcess();
  const instance: PTYInstance = {
    id: 'pty-1',
    process: proc as unknown as PTYInstance['process'],
    shell: 'bash',
    workspaceId: 'ws-a',
  } as PTYInstance;
  const manager = {
    get: vi.fn(() => instance),
    remove: vi.fn(),
    onDispose: vi.fn(),
  } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const hookRouter = opts.hookRouter ?? stubHookRouter();
  const alarm = new CompletionAlarm({
    onConfirmed: (_pane, _slug, _cls, resume) => resume(),
  });
  const bridge = new PTYBridge(
    manager,
    () => win as never,
    () => hookRouter,
    () => alarm,
  );
  bridge.setupDataForwarding('pty-1');
  return { bridge, proc, hookRouter, alarm };
}

function pollLifecycle() {
  return eventBus.poll(0, { types: ['agent.lifecycle'] }).events as Array<{
    kind?: string;
    source?: string;
    decision?: string;
    agent?: string | null;
  }>;
}

function flush() {
  // PTYBridge.BATCH_INTERVAL_MS (8ms) — advance so AgentDetector middleware runs.
  vi.advanceTimersByTime(50);
}

describe('PTYBridge — detector verdict gate (CompletionAlarm)', () => {
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

  it('holds a waiting candidate and fires recordDetector/tee/toast only at confirmation', () => {
    const { proc, hookRouter } = makeRig();

    // Banner registers the agent AND emits the 'running' start event — that
    // is the working evidence that arms the turn gate.
    proc.emitData('Claude Code starting up\n');
    flush();
    const recordDetector = hookRouter.recordDetector as ReturnType<typeof vi.fn>;
    recordDetector.mockClear();

    proc.emitData('  shift+tab to cycle\n');
    flush();

    // Held: the provisional window is open, nothing has fanned out yet
    // (R1 — recordDetector lives inside the resume closure).
    expect(recordDetector).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(recordDetector).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'agent.stop',
      source: 'detector',
      agent: 'claude',
      decision: 'emit',
    });
  });

  it('a working cue inside the window rebuts the candidate — no toast, no ledger write', () => {
    const { bridge, proc, hookRouter } = makeRig();

    proc.emitData('Claude Code starting up\n');
    flush();
    proc.emitData('  shift+tab to cycle\n');
    flush();
    // User types into the pane right after the candidate — that is a
    // rebuttal, not a completion (the local mirror of session:active).
    bridge.noteUserInput('pty-1');

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(hookRouter.recordDetector).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
  });

  it('a post-completion footer repaint is rejected — internal trace only, no second toast', () => {
    // After a confirmed completion the pane is `announced` with no fresh
    // working evidence, so an idle-footer repaint (resize redraw, tracker
    // toggled on) must NOT re-toast. The gate key survives because the same
    // agent is still detected — this exercises the detector-side gate-miss
    // branch ('internal' tee, fan-out skipped).
    const { proc } = makeRig();

    proc.emitData('Claude Code starting up\n');
    flush();
    proc.emitData('  shift+tab to cycle\n');
    flush();
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    eventBus.reset();
    mocks.sendNotification.mockClear();

    // A DIFFERENT waiting-classified footer (the emission dedup is per-pattern
    // text), with no working evidence in between: the detector re-classifies,
    // and the ALARM gate must reject the announced pane — 'internal' only.
    proc.emitData('  bypass permissions on\n');
    flush();

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'detector', decision: 'internal' });

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('cleanupInstance cancels the pane’s pending window', () => {
    const { bridge, proc, hookRouter } = makeRig();

    proc.emitData('Claude Code starting up\n');
    flush();
    proc.emitData('  shift+tab to cycle\n');
    flush();
    bridge.cleanupInstance('pty-1');

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(hookRouter.recordDetector).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
  });
});
