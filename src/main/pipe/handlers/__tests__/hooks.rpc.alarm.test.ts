// Verdict-gate integration tests for the local (daemon-unreachable) hooks.rpc
// path with a REAL CompletionAlarm injected. Mirrors hooks.rpc.emit.test.ts's
// harness (mocked _bridge / sendNotification / metadata broadcast, stubbed
// HookSignalRouter) and adds `vi.useFakeTimers` to drive the 1.5s provisional
// window. The behaviors locked here:
//   - hold → confirmed: ledger write, lifecycle tee, usage probe, and toast
//     all fire only AFTER the window expires (R1 — recordHook at confirm time,
//     so the detector-then-hook race can never bury the broadcast in a stale
//     'dedup').
//   - hold → rebutted: nothing fires and the stop never touches the ledger.
//   - subagent_stop: 'internal' trace, no toast, no ledger write.
//   - stop(clean) replacing a pending done window: exactly one fan-out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { eventBus } from '../../../events/EventBus';
import type { HookSignalRouter } from '../../../hooks/HookSignalRouter';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';
import { CompletionAlarm, DEFAULT_ALARM_WINDOW_MS } from '../../../../shared/hooks/CompletionAlarm';

const { sendToRendererMock, sendNotificationMock, broadcastMetadataUpdateMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  broadcastMetadataUpdateMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../notification/sendNotification', () => ({
  sendNotification: sendNotificationMock,
}));

vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: broadcastMetadataUpdateMock,
}));

vi.mock('../../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { registerHooksRpc } from '../hooks.rpc';

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

function stubHookRouter() {
  const recordHook = vi.fn().mockReturnValue('emit');
  const router = {
    recordHook,
    recordDetector: vi.fn(),
    touchAuthority: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(false),
    governsDetectorStatus: vi.fn().mockReturnValue(false),
    getLatencyMeter: () => ({
      recordSignal: vi.fn(),
      recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => vi.fn(),
      getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
  return { router, recordHook };
}

function signal(overrides: Partial<AgentSignal>): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  } as AgentSignal;
}

function workspaces() {
  return [{
    id: 'ws-1',
    name: 'one',
    metadata: { cwd: '/repo' },
    activePtyId: 'pty-1',
    ptyIds: ['pty-1'],
  }];
}

function pollLifecycle() {
  const { events } = eventBus.poll(0, { types: ['agent.lifecycle'] });
  return events as Array<{ kind?: string; decision?: string }>;
}

interface Rig {
  router: RpcRouter;
  recordHook: ReturnType<typeof stubHookRouter>['recordHook'];
  onClaudeTurnEnd: ReturnType<typeof vi.fn>;
  dispatch: (overrides: Partial<AgentSignal>) => Promise<{ ok: boolean }>;
}

function rig(): Rig {
  const stub = stubHookRouter();
  const onClaudeTurnEnd = vi.fn();
  // Real alarm: main wires an unref'd schedule in production; tests just need
  // the default setTimeout, which fake timers control.
  const alarm = new CompletionAlarm({
    onConfirmed: (_pane, _slug, _cls, resume) => resume(),
  });
  const router = new RpcRouter();
  registerHooksRpc(router, () => fakeWindow(), stub.router, undefined, onClaudeTurnEnd, undefined, alarm);
  return {
    router,
    recordHook: stub.recordHook,
    onClaudeTurnEnd,
    dispatch: (overrides) => router.dispatch({
      id: `t-${Math.random().toString(36).slice(2, 6)}`,
      method: 'hooks.signal',
      params: signal(overrides) as unknown as Record<string, unknown>,
    }) as Promise<{ ok: boolean }>,
  };
}

/** Working evidence must precede a stop, or the turn gate rejects it. */
async function primeWorking(r: Rig): Promise<void> {
  await r.dispatch({ kind: 'agent.activity' });
  vi.clearAllMocks(); // the activity signal itself does not fan out
}

describe('hooks.signal — local verdict gate (CompletionAlarm)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    eventBus.reset();
    sendToRendererMock.mockResolvedValue(workspaces());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a stop, then fires ledger+tee+toast only at window confirmation', async () => {
    const r = rig();
    await primeWorking(r);

    const res = await r.dispatch({ kind: 'agent.stop' });
    expect(res.ok).toBe(true);
    // Held: nothing has fired yet — the provisional window is open.
    expect(r.recordHook).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
    expect(r.onClaudeTurnEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    // Confirmed: ledger FIRST (R1 — recordHook at confirm time), then the
    // tee carries decision 'emit', the usage probe rides the confirmed turn
    // end, and the toast fires exactly once.
    expect(r.recordHook).toHaveBeenCalledTimes(1);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent.stop', decision: 'emit' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(r.onClaudeTurnEnd).toHaveBeenCalledTimes(1);
  });

  // #1107 regression. The Codex hooks bridge registers UserPromptSubmit on an
  // ordinary pane and deliberately maps no PreToolUse/PostToolUse, so
  // `agent.user_prompt_submit` is that pane's ONLY working cue. This path used
  // to drop it before the alarm feed (on the premise that the brain lane was
  // its only emitter), which made the turn gate swallow the same turn's stop.
  // The daemon path never had the hole; this locks the main path symmetric.
  it('arms the turn gate from agent.user_prompt_submit so the stop survives', async () => {
    const r = rig();

    // The ONLY cue before the stop — no activity, no tool_started.
    await r.dispatch({ kind: 'agent.user_prompt_submit', agent: 'codex' });
    // It is not an emit kind: no toast, no ledger write, no lifecycle tee.
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(r.recordHook).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);

    await r.dispatch({ kind: 'agent.stop', agent: 'codex' });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    // The stop passed the `!seenWorking` gate and fanned out exactly once.
    expect(r.recordHook).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  // The other half of the same fix: session_start normalizes to a `session`
  // cue that RESETS seenWorking. So a Codex pane whose only prior signal was
  // SessionStart must still NOT announce — otherwise the gate is meaningless.
  it('does not let agent.session_start alone arm the gate', async () => {
    const r = rig();

    await r.dispatch({ kind: 'agent.session_start', agent: 'codex' });
    await r.dispatch({ kind: 'agent.stop', agent: 'codex' });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(r.recordHook).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('a working cue inside the window rebuts the stop — nothing fires, ledger untouched', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.stop' });
    // Tool resumed right after the stop: rebuttal inside the window.
    await r.dispatch({ kind: 'agent.tool_started' });

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(r.recordHook).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(r.onClaudeTurnEnd).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
  });

  it('a stop with no prior working evidence is rejected — internal trace, no toast', async () => {
    const r = rig();

    await r.dispatch({ kind: 'agent.stop' });

    // Turn-gate miss is an immediate drop, not a hold.
    expect(r.recordHook).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent.stop', decision: 'internal' });
  });

  it('a stop stamped with leftover background work is rejected even with working evidence', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.stop', payload: { wmux_leftover_work: 2 } });

    expect(r.recordHook).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].decision).toBe('internal');
  });

  it('subagent_stop never toasts: internal trace only, ledger untouched', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.subagent_stop' });

    expect(r.recordHook).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent.subagent_stop', decision: 'internal' });
  });

  it('a second clean stop replaces the pending window — exactly one fan-out (R2)', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.stop' });
    // The hook's stop supersedes the pending (detector-shaped) window.
    await r.dispatch({ kind: 'agent.stop' });

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(r.recordHook).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(r.onClaudeTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('awaiting_input holds as attention and confirms into the toast + dot', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.awaiting_input' });
    expect(sendNotificationMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'awaiting_input' }),
    );
  });

  // A turn that dies on an API error fires StopFailure and no Stop at all, so
  // without this branch the pane kept the amber dot its turn START lit until
  // the agent process died.
  it('stop_failure paints the pane error at once and toasts at confirmation', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.stop_failure' });
    // The status is not held: the turn is over NOW, and the dot is what the
    // operator is staring at. The toast still waits out the window.
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'error' }),
    );
    expect(sendNotificationMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(r.recordHook).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // Never 'complete': nothing finished.
    for (const [, patch] of broadcastMetadataUpdateMock.mock.calls) {
      expect((patch as { agentStatus?: string }).agentStatus).not.toBe('complete');
    }
  });

  it('tees a failed turn under its OWN lifecycle kind, and skips the usage probe', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.stop_failure' });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    // An orchestrator waiting on this pane must be woken — but never with
    // 'agent.stop', which would report the dead turn as a normal completion.
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent.stop_failure', decision: 'emit' });
    // No turn-end usage probe: the API call is what failed.
    expect(r.onClaudeTurnEnd).not.toHaveBeenCalled();
  });

  it('tees a DEDUPED failure too — the turn died whichever source spoke first', async () => {
    const r = rig();
    await primeWorking(r);
    r.recordHook.mockReturnValue('dedup');

    await r.dispatch({ kind: 'agent.stop_failure' });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent.stop_failure', decision: 'dedup' });
    // Only the toast is gated on 'emit'.
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('closes the turn gate, so a stop behind the failure raises no completion', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.stop_failure' });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    vi.clearAllMocks();

    // No new working evidence in between: the confirmed attention window set
    // `announced` and cleared `seenWorking`, so this cannot announce.
    await r.dispatch({ kind: 'agent.stop' });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(r.recordHook).not.toHaveBeenCalled();
  });

  it('an answered cue rebuts a pending attention window', async () => {
    const r = rig();
    await primeWorking(r);

    await r.dispatch({ kind: 'agent.awaiting_input' });
    await r.dispatch({ kind: 'agent.input_answered' });

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(broadcastMetadataUpdateMock).not.toHaveBeenCalled();
  });
});
