import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CompletionAlarm,
  normalizeHookCue,
  normalizeDetectorCue,
  DEFAULT_ALARM_WINDOW_MS,
} from '../CompletionAlarm';
import type { AlarmClass, AlarmCue } from '../CompletionAlarm';
import type { AgentSignal } from '../signal-types';

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/some/dir',
    payload: {},
    ts: 1000,
    ...overrides,
  };
}

const STOP: AlarmCue = { class: 'stop', child: false, leftoverWork: 0 };
const WORKING: AlarmCue = { class: 'working' };
const ATTENTION: AlarmCue = { class: 'attention' };

interface Confirmed {
  pane: string;
  slug: string;
  cls: AlarmClass;
  resume: () => void;
}

describe('CompletionAlarm', () => {
  let confirmed: Confirmed[];
  let alarm: CompletionAlarm;

  beforeEach(() => {
    vi.useFakeTimers();
    confirmed = [];
    alarm = new CompletionAlarm({
      onConfirmed: (pane, slug, cls, resume) => confirmed.push({ pane, slug, cls, resume }),
    });
  });

  afterEach(() => {
    alarm.dispose();
    vi.useRealTimers();
  });

  // The canonical happy path: prompt → agent works → stops → nothing rebuts
  // within the window → completion confirmed.
  it('working → clean stop → window expires → done confirmed', () => {
    expect(alarm.observe('p1', 'claude', WORKING)).toBe('drop');
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    expect(confirmed).toHaveLength(0);
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toEqual([{ pane: 'p1', slug: 'claude', cls: 'done', resume: expect.any(Function) }]);
  });

  it('clean stop with NO working evidence is dropped (idle chrome repaint)', () => {
    expect(alarm.observe('p1', 'claude', STOP)).toBe('drop');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
  });

  it('stop rebutted by working within the window: no confirmation', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    expect(alarm.observe('p1', 'claude', WORKING)).toBe('drop');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
  });

  it('subagent stop never opens a window and cancels a pending done', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    expect(alarm.observe('p1', 'claude', { class: 'stop', child: true, leftoverWork: 0 })).toBe('drop');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
  });

  it('stop with leftover background work is treated as working evidence', () => {
    alarm.observe('p1', 'claude', WORKING);
    // Agent stops while a background build runs: no alarm...
    expect(alarm.observe('p1', 'claude', { class: 'stop', child: false, leftoverWork: 2 })).toBe('drop');
    // ...and the gate stays armed, so the eventual real stop confirms.
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toHaveLength(1);
  });

  it('clean stop REPLACES a pending done window (detector then hook, R2)', () => {
    alarm.observe('p1', 'claude', WORKING);
    const resume1 = vi.fn();
    const resume2 = vi.fn();
    expect(alarm.observe('p1', 'claude', STOP, resume1)).toBe('hold');
    // 100ms later the canonical hook Stop supersedes the detector candidate.
    vi.advanceTimersByTime(100);
    expect(alarm.observe('p1', 'claude', STOP, resume2)).toBe('hold');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // Only the SECOND window's resume fires — the first was replaced.
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].resume).toBe(resume2);
    expect(resume1).not.toHaveBeenCalled();
  });

  it('announced blocks re-announcing until the next working cue clears it', () => {
    alarm.observe('p1', 'claude', WORKING);
    alarm.observe('p1', 'claude', STOP);
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toHaveLength(1);
    // Detector repaint of the same turn: no second window.
    expect(alarm.observe('p1', 'claude', STOP)).toBe('drop');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(1);
    // Next turn: working clears announced, stop confirms again.
    expect(alarm.observe('p1', 'claude', WORKING)).toBe('drop');
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toHaveLength(2);
  });

  it('session boundary resets the gate', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', { class: 'session' })).toBe('drop');
    // seenWorking cleared → a stop right after resume is rejected.
    expect(alarm.observe('p1', 'claude', STOP)).toBe('drop');
  });

  it('attention opens its own window and confirms as attention', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', ATTENTION)).toBe('hold');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toEqual([expect.objectContaining({ cls: 'attention' })]);
  });

  it('attention cancels a pending done window (stop raced an approval prompt)', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    expect(alarm.observe('p1', 'claude', ATTENTION)).toBe('hold');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toEqual([expect.objectContaining({ cls: 'attention' })]);
  });

  it('answered cancels a pending attention window', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', ATTENTION)).toBe('hold');
    expect(alarm.observe('p1', 'claude', { class: 'answered' })).toBe('drop');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
  });

  it('answered is a no-op when no attention window is pending', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', { class: 'answered' })).toBe('drop');
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(confirmed).toHaveLength(1);
  });

  it('working cancels a pending attention window too (rebuttal is symmetric)', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', ATTENTION)).toBe('hold');
    expect(alarm.observe('p1', 'claude', WORKING)).toBe('drop');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
  });

  it('states are independent per (slug, pane) key', () => {
    alarm.observe('p1', 'claude', WORKING);
    // codex on the same pane has NO working evidence → its stop is rejected.
    expect(alarm.observe('p1', 'codex', STOP)).toBe('drop');
    // claude on a different pane likewise.
    expect(alarm.observe('p2', 'claude', STOP)).toBe('drop');
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
  });

  it('dropPty cancels that pane\'s windows and resets its gate', () => {
    alarm.observe('p1', 'claude', WORKING);
    expect(alarm.observe('p1', 'claude', STOP)).toBe('hold');
    alarm.dropPty('p1');
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
    // Post-drop the pane starts from an empty state (no seenWorking).
    expect(alarm.observe('p1', 'claude', STOP)).toBe('drop');
  });

  it('dispose cancels every window', () => {
    alarm.observe('p1', 'claude', WORKING);
    alarm.observe('p2', 'claude', WORKING);
    alarm.observe('p1', 'claude', STOP);
    alarm.observe('p2', 'claude', STOP);
    alarm.dispose();
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 3);
    expect(confirmed).toHaveLength(0);
  });
});

describe('normalizeHookCue', () => {
  it('maps working-evidence kinds to working', () => {
    for (const kind of ['agent.activity', 'agent.tool_started', 'agent.awaiting_permission', 'agent.user_prompt_submit'] as const) {
      expect(normalizeHookCue(makeSignal({ kind }))).toEqual({ class: 'working' });
    }
  });

  it('maps stop with leftover work stamped by the bridge', () => {
    expect(normalizeHookCue(makeSignal({ payload: { wmux_leftover_work: 3 } })))
      .toEqual({ class: 'stop', child: false, leftoverWork: 3 });
  });

  it('treats absent, zero, negative and non-numeric leftover as 0', () => {
    expect(normalizeHookCue(makeSignal())).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
    expect(normalizeHookCue(makeSignal({ payload: { wmux_leftover_work: 0 } }))).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
    expect(normalizeHookCue(makeSignal({ payload: { wmux_leftover_work: -1 } }))).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
    expect(normalizeHookCue(makeSignal({ payload: { wmux_leftover_work: '2' } }))).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
    expect(normalizeHookCue(makeSignal({ payload: { wmux_leftover_work: NaN } }))).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
  });

  it('maps subagent_stop to a child stop', () => {
    expect(normalizeHookCue(makeSignal({ kind: 'agent.subagent_stop' })))
      .toEqual({ class: 'stop', child: true, leftoverWork: 0 });
  });

  it('maps awaiting_input / answered / session_start', () => {
    expect(normalizeHookCue(makeSignal({ kind: 'agent.awaiting_input' }))).toEqual({ class: 'attention' });
    expect(normalizeHookCue(makeSignal({ kind: 'agent.input_answered' }))).toEqual({ class: 'answered' });
    expect(normalizeHookCue(makeSignal({ kind: 'agent.permission_answered' }))).toEqual({ class: 'answered' });
    expect(normalizeHookCue(makeSignal({ kind: 'agent.session_start' }))).toEqual({ class: 'session' });
  });
});

describe('normalizeDetectorCue', () => {
  it('running → working', () => {
    expect(normalizeDetectorCue('running')).toEqual({ class: 'working' });
  });

  it('waiting and complete → clean stop candidates (detector cannot see leftover work)', () => {
    expect(normalizeDetectorCue('waiting')).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
    expect(normalizeDetectorCue('complete')).toEqual({ class: 'stop', child: false, leftoverWork: 0 });
  });

  it('awaiting_input → attention', () => {
    expect(normalizeDetectorCue('awaiting_input')).toEqual({ class: 'attention' });
  });

  it('unknown statuses carry no alarm semantics', () => {
    expect(normalizeDetectorCue('idle')).toBeNull();
    expect(normalizeDetectorCue('whatever')).toBeNull();
  });
});
