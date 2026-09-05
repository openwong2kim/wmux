// Lane F: worker events copied from a fan-out task workspace to the owning
// workspace carry a `task` tag — the parent's 'none' wake policy must let
// them through, and an orphan backlog replays on the human send that boots
// the brain.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CommanderEventCoalescer,
  buildEventPrompt,
  type CoalescerInput,
} from '../CommanderEventCoalescer';
import { DEFAULT_AUTONOMY, type WorkspaceAutonomy } from '../deckAutonomyStore';

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function mk(autonomy: WorkspaceAutonomy, backlog: CoalescerInput[] = [], extra: { pendingDecision?: () => boolean; runOk?: () => boolean } = {}) {
  const prompts: { ws: string; prompt: string }[] = [];
  const acks: number[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return extra.runOk ? { ok: extra.runOk(), code: 'spawn_failed' } : { ok: true };
    },
    isBusy: () => false,
    getAutonomy: () => autonomy,
    ...(extra.pendingDecision ? { hasPendingDecision: extra.pendingDecision } : {}),
    peekOrphanBacklog: () => [...backlog],
    ackOrphanBacklog: (_ws, upToSeq) => {
      acks.push(upToSeq);
      for (let i = backlog.length - 1; i >= 0; i--) if (backlog[i].seq <= upToSeq) backlog.splice(i, 1);
    },
    debounceMs: 1_000,
  });
  return { c, prompts, acks };
}

function stop(over: Partial<CoalescerInput> = {}): CoalescerInput {
  return {
    workspaceId: 'ws-parent',
    ptyId: 'pty-worker',
    kind: 'agent.stop',
    source: 'hook',
    agent: 'claude',
    seq: 1,
    ts: 0,
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('delegated-task events under wakePolicy none', () => {
  it('a tagged worker stop wakes the parent even though its policy is none', async () => {
    const { c, prompts } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' });
    c.push(stop({ task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].ws).toBe('ws-parent');
    expect(prompts[0].prompt).toContain('worker-task=wtask-1 ws=ws-task');
  });

  // Before agent.stop_failure had its own lifecycle kind, a worker whose turn
  // died on an API error produced no wake at all — the parent sat on the stop
  // gate until something unrelated woke it.
  it('a tagged worker whose turn DIED wakes the parent with the failure reason', async () => {
    const { c, prompts } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' });
    c.push(stop({
      kind: 'agent.stop_failure',
      task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' },
    }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('kind=stop-failed');
    // The reason must not read like a completed turn — `stopVerdict`'s
    // canonical opener is what a brain matches on for "finished".
    expect(prompts[0].prompt).toContain('TURN DIED ON AN API ERROR');
    expect(prompts[0].prompt).not.toContain('(turn ended');
  });

  it('an untagged stop is still consumed under none (unchanged behaviour)', async () => {
    const { c, prompts } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' });
    c.push(stop());
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
    expect(c.getPhase('ws-parent')).toBe('idle');
  });

  it('under none only the tagged events reach the prompt; foreign ones are consumed alongside', async () => {
    const { c, prompts } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' });
    c.push(stop({ ptyId: 'pty-foreign', seq: 1 }));
    c.push(stop({ ptyId: 'pty-worker', seq: 2, task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).not.toContain('pty-foreign');
    // Both seqs are behind the watermark now — neither replays.
    c.push(stop({ ptyId: 'pty-foreign', seq: 1 }));
    c.push(stop({ ptyId: 'pty-worker', seq: 2, task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
  });

  it('value-filtered treats a tagged plain stop as worthy', async () => {
    const { c, prompts } = mk({ ...DEFAULT_AUTONOMY, mode: 'assist', wakePolicy: 'value-filtered' });
    c.push(stop({ task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
  });
});

describe('orphan backlog replay (peek → deliver → ack)', () => {
  const orphan = () => stop({ workspaceId: 'ws-parent', seq: 3, task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } });

  it('a human send replays the backlog, its stale seq still flushes, and delivery acks it', async () => {
    const backlog = [orphan()];
    const { c, prompts, acks } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' }, backlog);
    c.push(stop({ ptyId: 'pty-x', seq: 10 }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
    c.notifyHumanSend('ws-parent');
    expect(backlog).toHaveLength(1); // peeked, not taken
    c.notifyIdle('ws-parent');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('worker-task=wtask-1');
    expect(acks).toEqual([3]);
    expect(backlog).toHaveLength(0);
  });

  it('a flush consumed by a pending decision leaves the backlog parked (no ack)', async () => {
    const backlog = [orphan()];
    const { c, prompts, acks } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' }, backlog, { pendingDecision: () => true });
    c.notifyBrainBooted('ws-parent');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
    expect(acks).toEqual([]);
    expect(backlog).toHaveLength(1);
  });

  it('a failed turn leaves the backlog parked; a later boot replays it', async () => {
    const backlog = [orphan()];
    let ok = false;
    const { c, prompts, acks } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' }, backlog, { runOk: () => ok });
    c.notifyBrainBooted('ws-parent');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(acks).toEqual([]);
    expect(backlog).toHaveLength(1);
    ok = true;
    c.notifyBrainBooted('ws-parent');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(2);
    expect(acks).toEqual([3]);
    expect(backlog).toHaveLength(0);
  });
});

describe('buildEventPrompt with a task tag', () => {
  it('names the worker task and workspace on the line', () => {
    const prompt = buildEventPrompt(
      [{ ptyId: 'p', kind: 'agent.stop', source: 'hook', agent: 'claude', seq: 1, ts: 0, task: { taskId: 't1', taskWorkspaceId: 'w1' } }],
      DEFAULT_AUTONOMY,
      { remaining: 1, total: 1 },
    );
    expect(prompt).toContain('worker-task=t1 ws=w1 pane=p(claude)');
  });
});
