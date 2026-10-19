// A Claude PermissionRequest is tentative: it raises no "needs you" by itself.
// The firm signal is Claude's own Notification of type `permission_prompt`,
// sent once the prompt has waited ~6 s. Reported as a toast every ~2 s while
// the agent visibly kept working (requests decided by another hook or the SDK
// host, auto-denied background agents, dialogs answered at once).
//
// Second layer: a pane that has never sent that Notification (the hook is not
// registered there) gets a screen check PERMISSION_NOTIFY_GRACE_MS after the
// request; a dialog still up raises the alarm.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HookIngest,
  DIALOG_RECHECK_MS,
  PERMISSION_NOTIFY_GRACE_MS,
  type DetectorHeldEventData,
  type HookAgentEventData,
  type HookIngestDeps,
  type HookIngestSession,
} from '../HookIngest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

const PERMISSION_REQUEST = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
};

const PERMISSION_NOTIFICATION = {
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
  message: 'Claude needs your permission to use Bash',
};

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return { kind: 'agent.awaiting_input', agent: 'claude', cwd: '/repo', payload: PERMISSION_REQUEST, ts: 1_000, ptyId: 'pty-a', ...overrides };
}

const notification = (ts = 7_000): AgentSignal => makeSignal({ payload: PERMISSION_NOTIFICATION, ts });

function makeIngest(dialogOnScreen?: HookIngestDeps['dialogOnScreen']) {
  const sessions: HookIngestSession[] = [{ id: 'pty-a', cwd: '/repo', env: {} }];
  const emitted: HookAgentEventData[] = [];
  const detectorEmitted: DetectorHeldEventData[] = [];
  const cards: string[] = [];
  const terminalPrompts: string[] = [];
  const logs: string[] = [];
  const lapsed: string[] = [];
  let clock = 10_000;
  const deps: HookIngestDeps = {
    listLiveSessions: () => sessions,
    emitAgentEvent: (_id, data) => { emitted.push(data); },
    emitDetectorEvent: (_id, data) => { detectorEmitted.push(data); },
    applyResumeBinding: () => undefined,
    approvals: {
      noteHookAwaitingInput: (input) => { cards.push(input.sessionId); },
      noteGateAwaiting: () => 'gate-id',
      expireForSession: () => undefined,
      noteTerminalPrompt: async (note) => { terminalPrompts.push(note.sessionId); },
    },
    log: (_level, message) => { logs.push(message); },
    now: () => clock,
    onTentativeDialogLapsed: (id) => { lapsed.push(id); },
    ...(dialogOnScreen ? { dialogOnScreen } : {}),
  };
  const ingest = new HookIngest(deps);
  const awaiting = () => emitted.filter((e) => e.status === 'awaiting_input');
  // What becomes a toast: an emitted (not deduped) awaiting broadcast, from
  // either source.
  const toasts = () => awaiting().filter((e) => e.decision === 'emit').length
    + detectorEmitted.filter((e) => e.status === 'awaiting_input' && e.decision === 'emit').length;
  return { ingest, emitted, detectorEmitted, cards, terminalPrompts, logs, lapsed, awaiting, toasts, advance: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); } };
}

async function settle(): Promise<void> {
  // The screen check resolves on the microtask queue after the grace timer.
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Run the second layer to its end: grace, first read, re-read, alarm window. */
async function runSecondLayer(f: ReturnType<typeof makeIngest>): Promise<void> {
  f.advance(PERMISSION_NOTIFY_GRACE_MS);
  await settle();
  f.advance(DIALOG_RECHECK_MS);
  await settle();
  f.advance(DEFAULT_ALARM_WINDOW_MS);
  await settle();
}

/** Teach the pane that its Claude sends the permission Notification. */
async function learnNotification(f: ReturnType<typeof makeIngest>): Promise<void> {
  f.ingest.handle(makeSignal());
  f.ingest.handle(notification());
  f.advance(DEFAULT_ALARM_WINDOW_MS);
  await settle();
  f.ingest.noteAnswered('pty-a', 'claude');
  f.emitted.length = 0;
}

describe('HookIngest — a Claude PermissionRequest is tentative', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('raises nothing by itself: no broadcast, no pane status, inside the old 1.5 s window or after it', async () => {
    const f = makeIngest(async () => false);
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS * 2);
    await settle();
    expect(f.emitted).toEqual([]);
  });

  it('keeps the phone record: the request reaches the registry at once, as a terminal_prompt', () => {
    const f = makeIngest();
    f.ingest.handle(makeSignal());
    expect(f.terminalPrompts).toEqual(['pty-a']);
    expect(f.cards).toEqual([]);
  });

  it('the reported storm: five requests 2 s apart, auto-resolved, no Notification → zero alarms', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    for (let i = 0; i < 5; i++) {
      f.ingest.handle(makeSignal({ ts: 1_000 + i * 2_000 }));
      f.advance(500);
      f.ingest.handle(makeSignal({ kind: 'agent.activity', payload: {}, ts: 1_500 + i * 2_000 }));
      f.advance(1_500);
      await settle();
    }
    await runSecondLayer(f);
    await runSecondLayer(f);
    expect(f.awaiting()).toEqual([]);
    expect(f.toasts()).toBe(0);
    // One timer per pane, not one screen read per hook.
    expect(screen.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('the storm on a pane that sends the Notification: zero alarms and no screen read at all', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    await learnNotification(f);
    for (let i = 0; i < 5; i++) {
      f.ingest.handle(makeSignal({ ts: 20_000 + i * 2_000 }));
      f.advance(2_000);
      await settle();
    }
    await runSecondLayer(f);
    expect(f.awaiting()).toEqual([]);
    expect(screen).not.toHaveBeenCalled();
  });
});

describe('HookIngest — the permission_prompt Notification is the firm signal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a real dialog: PermissionRequest, then the Notification ~6 s later → exactly one alarm', async () => {
    const screen = vi.fn(async () => true);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    f.advance(6_000);
    f.ingest.handle(notification());
    expect(f.awaiting()).toEqual([]);
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
    expect(f.awaiting()[0]).toMatchObject({ source: 'hook', decision: 'emit', hookKind: 'agent.awaiting_input' });
    // The root signal took over: no second layer behind it.
    await runSecondLayer(f);
    expect(f.awaiting()).toHaveLength(1);
    expect(screen).not.toHaveBeenCalled();
  });

  it('a later request (a background agent\'s, auto-decided) does not erase the pending Notification alarm', async () => {
    const f = makeIngest(async () => false);
    f.ingest.handle(makeSignal());
    f.advance(6_000);
    f.ingest.handle(notification());
    f.advance(500);
    f.ingest.handle(makeSignal({ ts: 7_500 }));
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('a new prompt or a turn end inside the Notification\'s window stands it down', async () => {
    for (const kind of ['agent.user_prompt_submit', 'agent.stop'] as const) {
      const f = makeIngest();
      f.ingest.handle(notification());
      f.advance(500);
      f.ingest.handle(makeSignal({ kind, payload: {}, ts: 7_500 }));
      f.advance(DEFAULT_ALARM_WINDOW_MS);
      await settle();
      expect(f.awaiting(), kind).toEqual([]);
    }
  });

  it('a Notification with no request before it (a sandboxed network prompt) alarms too', async () => {
    const f = makeIngest(async () => false);
    f.ingest.handle(notification());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('a Notification raises no AskUserQuestion card (it names no tool), but asks for a screen-read phone record', () => {
    const f = makeIngest();
    f.ingest.handle(notification());
    expect(f.cards).toEqual([]);
    // The registry refuses it while the request's own record is pending.
    expect(f.terminalPrompts).toEqual(['pty-a']);
  });

  it('subagent work behind the dialog does not rebut it', async () => {
    const f = makeIngest();
    f.ingest.handle(notification());
    f.ingest.handle(makeSignal({ kind: 'agent.activity', payload: { tool_name: 'Grep' }, ts: 7_100 }));
    f.ingest.notePaneWorking('pty-a', 'claude');
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('the detector saw the dialog first: the Notification after it is a dedup, so one toast', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    f.advance(200);
    expect(f.ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' }).decision).toBe('pending');
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    f.advance(4_300);
    f.ingest.handle(notification());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.toasts()).toBe(1);
  });

  it('ignores every other notification type (the bridge forwards none; an older sender might)', async () => {
    const f = makeIngest();
    for (const type of ['idle_prompt', 'auth_success', 'elicitation_dialog', undefined]) {
      f.ingest.handle(makeSignal({ payload: { hook_event_name: 'Notification', ...(type ? { notification_type: type } : {}) } }));
    }
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.emitted).toEqual([]);
    expect(f.cards).toEqual([]);
    // Nor does one replace a real dialog's pending alarm.
    const h = makeIngest();
    h.ingest.handle(notification());
    h.advance(500);
    h.ingest.handle(makeSignal({ payload: { hook_event_name: 'Notification', notification_type: 'idle_prompt' } }));
    h.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(h.awaiting()).toHaveLength(1);
    // And it does not mark the pane as one that sends the permission prompt.
    const screen = vi.fn(async () => true);
    const g = makeIngest(screen);
    g.ingest.handle(makeSignal({ payload: { hook_event_name: 'Notification', notification_type: 'idle_prompt' } }));
    g.ingest.handle(makeSignal());
    await runSecondLayer(g);
    expect(screen).toHaveBeenCalled();
  });
});

describe('HookIngest — second layer: no Notification from this pane', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a dialog still on screen after the grace raises one alarm', async () => {
    const screen = vi.fn(async () => true);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS - 1);
    await settle();
    expect(screen).not.toHaveBeenCalled();
    f.advance(1);
    await settle();
    expect(screen).toHaveBeenCalledTimes(1);
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('no dialog on two reads → dropped and logged', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    expect(screen).toHaveBeenCalledTimes(2);
    expect(f.awaiting()).toEqual([]);
    expect(f.logs.some((l) => l.includes('dropped: no permission_prompt Notification and no dialog on screen'))).toBe(true);
  });

  it('a dialog drawn late (slow third-party hook) is caught by the re-read', async () => {
    let drawn = false;
    const f = makeIngest(async () => drawn);
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS);
    await settle();
    drawn = true;
    f.advance(DIALOG_RECHECK_MS);
    await settle();
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('trusts the hook when the grid is unreadable or narrow (null), the check rejects, or it throws (#1901)', async () => {
    for (const check of [
      async () => null,
      async () => { throw new Error('render failed'); },
      () => { throw new Error('sync'); },
    ] as Array<NonNullable<HookIngestDeps['dialogOnScreen']>>) {
      const f = makeIngest(check);
      f.ingest.handle(makeSignal());
      await runSecondLayer(f);
      expect(f.awaiting()).toHaveLength(1);
    }
  });

  it('without a screen reader the hook is trusted after the grace', async () => {
    const f = makeIngest();
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    expect(f.awaiting()).toEqual([]);
    await runSecondLayer(f);
    expect(f.awaiting()).toHaveLength(1);
  });

  it('a stream of requests does not postpone the check behind a dialog that is really up', async () => {
    const f = makeIngest(async () => true);
    for (let i = 0; i < 4; i++) {
      f.ingest.handle(makeSignal({ ts: 1_000 + i * 2_000 }));
      f.advance(2_000);
      await settle();
    }
    f.advance(PERMISSION_NOTIFY_GRACE_MS - 8_000 + DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('SessionStart forgets that the pane sends the Notification', async () => {
    const screen = vi.fn(async () => true);
    const f = makeIngest(screen);
    await learnNotification(f);
    f.ingest.handle(makeSignal({ kind: 'agent.session_start', payload: { source: 'startup' }, ts: 30_000 }));
    f.ingest.handle(makeSignal({ ts: 31_000 }));
    await runSecondLayer(f);
    expect(screen).toHaveBeenCalled();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('an answer before the grace ends cancels it (hook or the answer keystroke)', async () => {
    for (const answer of [
      (f: ReturnType<typeof makeIngest>) => { f.ingest.handle(makeSignal({ kind: 'agent.permission_answered', payload: {}, ts: 2_000 })); },
      (f: ReturnType<typeof makeIngest>) => { f.ingest.noteAnswered('pty-a', 'claude'); },
      (f: ReturnType<typeof makeIngest>) => { f.ingest.noteAnswered('pty-a'); },
    ]) {
      const screen = vi.fn(async () => true);
      const f = makeIngest(screen);
      f.ingest.handle(makeSignal());
      f.advance(1_000);
      answer(f);
      await runSecondLayer(f);
      expect(screen).not.toHaveBeenCalled();
      expect(f.awaiting()).toEqual([]);
    }
  });

  it('stands down when the dialog was answered, the turn ended, a prompt or the Notification arrived during the read', async () => {
    for (const settleWith of [
      (f: ReturnType<typeof makeIngest>) => f.ingest.handle(makeSignal({ kind: 'agent.permission_answered', payload: {}, ts: 9_000 })),
      (f: ReturnType<typeof makeIngest>) => f.ingest.handle(makeSignal({ kind: 'agent.stop', payload: {}, ts: 9_000 })),
      (f: ReturnType<typeof makeIngest>) => f.ingest.handle(makeSignal({ kind: 'agent.user_prompt_submit', payload: {}, ts: 9_000 })),
      // Race 1 (verification P2): the answer keystroke reaches noteAnswered,
      // which must move the epoch too.
      (f: ReturnType<typeof makeIngest>) => f.ingest.noteAnswered('pty-a', 'claude'),
    ]) {
      let resolve: (up: boolean | null) => void = () => undefined;
      const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
      f.ingest.handle(makeSignal());
      f.advance(PERMISSION_NOTIFY_GRACE_MS);
      await settle();
      settleWith(f);
      resolve(true);
      await settle();
      f.advance(DEFAULT_ALARM_WINDOW_MS);
      await settle();
      expect(f.awaiting()).toEqual([]);
      expect(f.logs.some((l) => l.includes('stood down'))).toBe(true);
    }
  });

  it('a dialog drawn late: the second layer raises it, and its Notification after the grace adds no second toast', async () => {
    for (const notifyAfter of [500, DEFAULT_ALARM_WINDOW_MS + 500]) {
      const f = makeIngest(async () => true);
      f.ingest.handle(makeSignal());
      f.advance(PERMISSION_NOTIFY_GRACE_MS);
      await settle();
      f.advance(notifyAfter);
      f.ingest.handle(notification(10_000));
      f.advance(DEFAULT_ALARM_WINDOW_MS * 2);
      await settle();
      expect(f.toasts(), `Notification ${notifyAfter} ms after the read`).toBe(1);
    }
  });

  it('a new prompt after a positive read, inside the alarm window, stands it down', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS);
    await settle();
    f.advance(500);
    f.ingest.handle(makeSignal({ kind: 'agent.user_prompt_submit', payload: {}, ts: 9_500 }));
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toEqual([]);
  });

  it('a next dialog whose predecessor closed with no epoch move (a click answer) still marks the pane, as a dedup', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    f.ingest.handle(makeSignal({ ts: 30_000 }));
    await runSecondLayer(f);
    expect(f.awaiting()).toHaveLength(2);
    expect(f.awaiting().map((e) => e.decision)).toEqual(['emit', 'dedup']);
    expect(f.toasts()).toBe(1);
  });

  it('another request while the raised dialog is still unsettled adds no second toast; after it closes, a new one can', async () => {
    const screen = vi.fn(async () => true);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    expect(f.toasts()).toBe(1);
    f.ingest.handle(makeSignal({ ts: 20_000 }));
    await runSecondLayer(f);
    expect(f.toasts()).toBe(1);
    // The dialog closes (answer keystroke or the verifier's screen-cleared).
    f.ingest.noteAnswered('pty-a', 'claude');
    f.ingest.handle(makeSignal({ ts: 40_000 }));
    await runSecondLayer(f);
    expect(f.toasts()).toBe(2);
  });

  it('a request during the in-flight screen read does not raise the same dialog twice', async () => {
    let resolve: (up: boolean | null) => void = () => undefined;
    let reads = 0;
    const f = makeIngest(() => { reads++; return reads === 1 ? new Promise<boolean | null>((r) => { resolve = r; }) : Promise.resolve(true); });
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS);
    await settle();
    f.ingest.handle(makeSignal({ ts: 9_100 }));
    resolve(true);
    await settle();
    await runSecondLayer(f);
    expect(f.toasts()).toBe(1);
  });

  it('a new dialog right after the first closed is checked on its own grace (the close moves the epoch meanwhile)', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    // Answered by mouse: nothing settles at once. A new request comes...
    f.ingest.handle(makeSignal({ ts: 20_000 }));
    f.advance(2_000);
    // ...and the verifier's screen-cleared release lands before its grace.
    f.ingest.noteAnswered('pty-a', 'claude');
    await runSecondLayer(f);
    expect(f.toasts()).toBe(2);
  });

  it('the detector replacing the raised window still counts as raised: a later request does not re-alert the open dialog', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS);
    await settle();
    f.advance(300);
    f.ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' });
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.toasts()).toBe(1);
    f.advance(2_000);
    f.ingest.handle(makeSignal({ ts: 22_000 }));
    await runSecondLayer(f);
    await runSecondLayer(f);
    expect(f.toasts()).toBe(1);
    expect(f.ingest.permissionRequestCount('pty-a')).toBe(2);
  });

  it('a request queued behind a raised dialog, then a turn end, on an unreadable grid → no alarm', async () => {
    let grid: boolean | null = true;
    const f = makeIngest(async () => grid);
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    expect(f.toasts()).toBe(1);
    f.ingest.handle(makeSignal({ ts: 20_000 }));
    f.advance(1_000);
    f.ingest.handle(makeSignal({ kind: 'agent.stop', payload: {}, ts: 21_000 }));
    grid = null;
    await runSecondLayer(f);
    expect(f.awaiting()).toHaveLength(1);
  });

  it('a detector report that replaced the raised window still stands down on a new prompt', async () => {
    for (const raiseBy of ['notification', 'screen'] as const) {
      const f = makeIngest(async () => true);
      if (raiseBy === 'notification') {
        f.ingest.handle(notification());
      } else {
        f.ingest.handle(makeSignal());
        f.advance(PERMISSION_NOTIFY_GRACE_MS);
        await settle();
      }
      f.advance(300);
      f.ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' });
      f.advance(300);
      f.ingest.handle(makeSignal({ kind: 'agent.user_prompt_submit', payload: {}, ts: 9_000 }));
      f.advance(DEFAULT_ALARM_WINDOW_MS * 2);
      await settle();
      expect(f.toasts(), raiseBy).toBe(0);
    }
  });

  it('a lead Stop with background work still running does not void the request', async () => {
    const screen = vi.fn(async () => true);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    f.advance(3_000);
    f.ingest.handle(makeSignal({ kind: 'agent.stop', payload: { wmux_leftover_work: 1 }, ts: 4_000 }));
    await runSecondLayer(f);
    expect(screen).toHaveBeenCalled();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('the Notification landing during the read leaves exactly one alarm', async () => {
    let resolve: (up: boolean | null) => void = () => undefined;
    const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS);
    await settle();
    f.ingest.handle(notification(9_000));
    resolve(true);
    await settle();
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('working evidence (a subagent\'s PostToolUse, SubagentStop, tool start) does NOT stand it down', async () => {
    for (const other of [
      makeSignal({ kind: 'agent.activity', payload: {}, ts: 9_000 }),
      makeSignal({ kind: 'agent.subagent_stop', payload: {}, ts: 9_000 }),
      makeSignal({ kind: 'agent.tool_started', payload: {}, ts: 9_000 }),
    ]) {
      let resolve: (up: boolean | null) => void = () => undefined;
      const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
      f.ingest.handle(makeSignal());
      f.advance(PERMISSION_NOTIFY_GRACE_MS);
      await settle();
      f.ingest.handle(other);
      resolve(true);
      await settle();
      f.advance(DEFAULT_ALARM_WINDOW_MS);
      await settle();
      expect(f.awaiting(), other.kind).toHaveLength(1);
    }
  });

  it('race 2 (verification P2): a detector attention report does not skip the screen check', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    f.advance(100);
    f.ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' });
    await runSecondLayer(f);
    // The hook's own alarm still asked the screen, and found nothing.
    expect(screen).toHaveBeenCalled();
    expect(f.awaiting()).toEqual([]);
  });

  it('a pane dropped during the read never gets a broadcast', async () => {
    let resolve: (up: boolean | null) => void = () => undefined;
    const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
    f.ingest.handle(makeSignal());
    f.advance(PERMISSION_NOTIFY_GRACE_MS);
    await settle();
    f.ingest.dropPty('pty-a');
    resolve(true);
    await settle();
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toEqual([]);
  });

  it('a pane dropped before the grace ends never reads its screen', async () => {
    const screen = vi.fn(async () => true);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    f.ingest.dropPty('pty-a');
    await runSecondLayer(f);
    expect(screen).not.toHaveBeenCalled();
  });

  it('a throwing fan-out is logged once, not retried through the error path', async () => {
    const f = makeIngest(async () => true);
    let calls = 0;
    (f.ingest as unknown as { deps: HookIngestDeps }).deps.emitAgentEvent = () => { calls++; throw new Error('consumer threw'); };
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    expect(calls).toBe(1);
  });
});

describe('HookIngest — a lapsed request hands its phone record back', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Codex round 4: the record is minted at once and the pane is never marked
  // awaiting, so without this the record outlived the push grace.
  it('lapses when the second layer finds no dialog, when settled first, and on a pane that sends the Notification but sent none', async () => {
    const a = makeIngest(async () => false);
    a.ingest.handle(makeSignal());
    await runSecondLayer(a);
    expect(a.lapsed).toEqual(['pty-a']);

    const b = makeIngest(async () => true);
    b.ingest.handle(makeSignal());
    b.ingest.handle(makeSignal({ kind: 'agent.stop', payload: {}, ts: 2_000 }));
    await runSecondLayer(b);
    expect(b.lapsed).toEqual(['pty-a']);

    const c = makeIngest(async () => true);
    await learnNotification(c);
    c.ingest.handle(makeSignal({ ts: 20_000 }));
    await runSecondLayer(c);
    expect(c.lapsed).toEqual(['pty-a']);
    expect(c.awaiting()).toEqual([]);
  });

  it('does not lapse a request that was raised, or one whose Notification came', async () => {
    const a = makeIngest(async () => true);
    a.ingest.handle(makeSignal());
    await runSecondLayer(a);
    expect(a.awaiting()).toHaveLength(1);
    expect(a.lapsed).toEqual([]);

    const b = makeIngest(async () => false);
    b.ingest.handle(makeSignal());
    b.advance(6_000);
    b.ingest.handle(notification());
    await runSecondLayer(b);
    expect(b.lapsed).toEqual([]);
  });

  it('a throwing lapse handler is logged, never thrown from the timer', async () => {
    const f = makeIngest(async () => false);
    (f.ingest as unknown as { deps: HookIngestDeps }).deps.onTentativeDialogLapsed = () => { throw new Error('sweep exploded'); };
    f.ingest.handle(makeSignal());
    await runSecondLayer(f);
    expect(f.logs.some((l) => l.includes('tentative dialog lapse failed'))).toBe(true);
  });
});

describe('HookIngest — other awaiting paths are unchanged', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('AskUserQuestion and a Codex PermissionRequest alarm after the usual window, with no screen read', async () => {
    const screen = vi.fn(async () => false);
    const a = makeIngest(screen);
    a.ingest.handle(makeSignal({ payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' } }));
    a.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(a.awaiting()).toHaveLength(1);

    const b = makeIngest(screen);
    b.ingest.handle(makeSignal({ agent: 'codex' }));
    b.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(b.awaiting()).toHaveLength(1);
    expect(screen).not.toHaveBeenCalled();
  });
});
