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

function mk(autonomy: WorkspaceAutonomy, backlog: CoalescerInput[] = []) {
  const prompts: { ws: string; prompt: string }[] = [];
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return { ok: true };
    },
    isBusy: () => false,
    getAutonomy: () => autonomy,
    takeOrphanBacklog: () => backlog.splice(0),
    debounceMs: 1_000,
  });
  return { c, prompts };
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

describe('orphan backlog replay', () => {
  it('a human send drains the backlog and its stale seqs still flush', async () => {
    const backlog = [stop({ workspaceId: 'ws-parent', seq: 3, task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } })];
    const { c, prompts } = mk({ ...DEFAULT_AUTONOMY, wakePolicy: 'none' }, backlog);
    // Advance the watermark past the orphan's seq first.
    c.push(stop({ ptyId: 'pty-x', seq: 10 }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
    c.notifyHumanSend('ws-parent');
    c.notifyIdle('ws-parent');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('worker-task=wtask-1');
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
