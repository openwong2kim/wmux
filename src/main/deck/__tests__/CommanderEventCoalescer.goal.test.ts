// The Moa goal contract in wake verdicts (moaGoalContract.ts): a fan-out task
// the approved goal created may be answered and instructed without the
// standing continue cap; hand-offs delivered under the goal may be answered
// with a follow-up hand-off; level 0 reduces everything to report only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommanderEventCoalescer, buildEventPrompt, type BufferedEvent, type CoalescerInput, type GoalHooks } from '../CommanderEventCoalescer';
import { type WorkspaceAutonomy } from '../deckAutonomyStore';

const ASSIST: WorkspaceAutonomy = { mode: 'assist', wakePolicy: 'all', summarize: true, continueInstruction: false, approvalPress: false };
const BUDGET = { remaining: 10, total: 10 };
const G = { goalId: 'G-abc123', humanOnly: ['database migration'] };

const hooks = (covered: string[], active: string | null = G.goalId): GoalHooks => ({
  cover: (ws) => (covered.includes(ws) ? G : null),
  active: (id) => (id === active ? G : null),
});

const taskInput = (taskWs: string): BufferedEvent => ({
  ptyId: 'a2a:t1', kind: 'a2a.input_required', source: 'a2a', agent: null, seq: 1, ts: 1,
  a2a: { taskId: 't1', from: 'ws-hq', to: taskWs, state: 'input-required' },
});
const taskStop = (taskWs: string): BufferedEvent => ({
  ptyId: 'pty-9', kind: 'agent.stop', source: 'hook', agent: 'claude', seq: 2, ts: 2,
  task: { taskId: 'wt-1', taskWorkspaceId: taskWs },
});
const taskAwaiting = (taskWs: string): BufferedEvent => ({
  ptyId: 'pty-9', kind: 'agent.awaiting_input', source: 'hook', agent: 'claude', seq: 3, ts: 3,
  task: { taskId: 'wt-1', taskWorkspaceId: taskWs },
});
const handoffInput = (goalId?: string): BufferedEvent => ({
  ptyId: 'a2a:t2', kind: 'a2a.input_required', source: 'a2a', agent: null, seq: 4, ts: 4,
  a2a: { taskId: 't2', from: 'operator', to: 'ws-seal', state: 'input-required', handoff: { question: 'Which fixture?', ...(goalId ? { goalId } : {}) } },
});

describe('goal verdicts — buildEventPrompt', () => {
  it('a task the goal created may be answered in assist mode', () => {
    const p = buildEventPrompt([taskInput('ws-task')], ASSIST, BUDGET, { goal: hooks(['ws-task']) });
    expect(p).toContain('resolve the question from policy/context');
    expect(p).toContain('[goal G-abc123');
    expect(p).toContain('database migration');
    expect(p).toMatch(/Push, PRs, merges/);
  });

  it('a task outside the goal stays report only', () => {
    const p = buildEventPrompt([taskInput('ws-other')], ASSIST, BUDGET, { goal: hooks(['ws-task']) });
    expect(p).toContain('do not answer it in this mode');
    expect(p).not.toContain('[goal ');
  });

  it('a stop from a goal task may get a follow-up instruction', () => {
    const covered = buildEventPrompt([taskStop('ws-task')], ASSIST, BUDGET, { goal: hooks(['ws-task']) });
    const outside = buildEventPrompt([taskStop('ws-x')], ASSIST, BUDGET, { goal: hooks(['ws-task']) });
    expect(covered).not.toEqual(outside);
    expect(covered).toContain('[goal G-abc123');
  });

  it('a permission prompt in a goal task is NEVER approvable by the goal', () => {
    const p = buildEventPrompt([taskAwaiting('ws-task')], ASSIST, BUDGET, { goal: hooks(['ws-task']) });
    expect(p).toContain('NOTIFY ONLY, do NOT approve');
  });

  it('a hand-off delivered under the active goal may be answered with a follow-up hand-off', () => {
    const p = buildEventPrompt([handoffInput(G.goalId)], ASSIST, BUDGET, { goal: hooks([]) });
    expect(p).toContain('under goal G-abc123');
    expect(p).toContain('moa_propose_handoff');
    expect(p).toContain('delivered without a card');
    expect(p).toContain('cannot send_message or terminal_send');
  });

  it('a hand-off of an ended goal, or outside any goal, is the operator\'s as before', () => {
    for (const ev of [handoffInput(G.goalId), handoffInput()]) {
      const p = buildEventPrompt([ev], ASSIST, BUDGET, { goal: hooks([], null) });
      expect(p).toContain('waiting on the operator');
      expect(p).not.toContain('delivered without a card');
    }
  });

  it('a hand-off is never treated as a goal task even when its workspace is covered', () => {
    const p = buildEventPrompt([handoffInput()], ASSIST, BUDGET, { goal: hooks(['ws-seal']) });
    expect(p).toContain('waiting on the operator');
  });
});

describe('goal verdicts — the coalescer wiring and level 0', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const DANGER: WorkspaceAutonomy = { mode: 'danger', wakePolicy: 'all', summarize: true, continueInstruction: true, approvalPress: true };
  const input = (ws: string): CoalescerInput => ({
    workspaceId: 'ws-hq', ptyId: 'a2a:t1', kind: 'a2a.input_required', source: 'a2a', agent: null, seq: 1, ts: 1,
    a2a: { taskId: 't1', from: 'ws-hq', to: ws, state: 'input-required' },
  });

  async function run(deps: { observeOnly?: () => boolean; goalCover?: (w: string, t: string) => typeof G | null; autonomy?: WorkspaceAutonomy }, ev: CoalescerInput): Promise<string> {
    const prompts: string[] = [];
    const c = new CommanderEventCoalescer({
      runTurn: async (_ws, prompt) => { prompts.push(prompt); return { ok: true }; },
      isBusy: () => false,
      getAutonomy: () => ({ ...(deps.autonomy ?? ASSIST) }),
      debounceMs: 10,
      wakeBudget: 100,
      maxWakesPerMin: 100,
      ...(deps.observeOnly ? { observeOnly: deps.observeOnly } : {}),
      ...(deps.goalCover ? { goalCover: deps.goalCover } : {}),
    });
    c.push(ev);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    return prompts[0] ?? '';
  }

  it('passes the goal cover through to the verdicts', async () => {
    const p = await run({ goalCover: (_w, t) => (t === 'ws-task' ? G : null) }, input('ws-task'));
    expect(p).toContain('[goal G-abc123');
  });

  it('a throwing goal lookup grants nothing', async () => {
    const p = await run({ goalCover: () => { throw new Error('x'); } }, input('ws-task'));
    expect(p).not.toContain('[goal ');
    expect(p).toContain('do not answer it in this mode');
  });

  it('level 0 turns even danger mode into report only', async () => {
    const drive = await run({ autonomy: DANGER }, input('ws-x'));
    expect(drive).toContain('resolve the question from policy/context');
    const observe = await run({ autonomy: DANGER, observeOnly: () => true }, input('ws-x'));
    expect(observe).toContain('do not answer it in this mode');
    expect(observe).toContain('approval-press=off');
  });
});
