// Wave 3, finding 12 — a pending decision was a SILENT kill switch.
//
// A decision left unanswered from a previous app session blocked every wake of
// the owner workspace for twenty minutes. Nothing said so: no log line, and the
// worker stops routed to the owner (tagged `task`) were consumed on the way in,
// so they were gone even after the human answered. Two properties are pinned
// here: the block is announced exactly once per rate window, and delegated work
// SURVIVES the block and reaches the brain on the resume turn.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommanderEventCoalescer, type CoalescerInput } from '../CommanderEventCoalescer';
import { DEFAULT_AUTONOMY } from '../deckAutonomyStore';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function mk(opts: { pending: () => boolean }) {
  const prompts: { ws: string; prompt: string }[] = [];
  const logs: string[] = [];
  let clock = 0;
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return { ok: true };
    },
    isBusy: () => false,
    getAutonomy: () => ({ ...DEFAULT_AUTONOMY }),
    hasPendingDecision: opts.pending,
    log: (line) => logs.push(line),
    now: () => clock,
    debounceMs: 1_000,
  });
  return { c, prompts, logs, tick: (ms: number) => { clock += ms; } };
}

function stop(over: Partial<CoalescerInput> = {}): CoalescerInput {
  return {
    workspaceId: 'ws-owner',
    ptyId: 'pty-worker',
    kind: 'agent.stop',
    source: 'hook',
    agent: 'claude',
    seq: 1,
    ts: 0,
    ...over,
  };
}

const TASK = { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the pending-decision gate logs what it blocked', () => {
  it('names the workspace, the event count and the delegated task ids', async () => {
    const { c, prompts, logs } = mk({ pending: () => true });
    c.push(stop({ seq: 1, ptyId: 'pty-a', task: TASK }));
    c.push(stop({ seq: 2, ptyId: 'pty-b' }));
    vi.advanceTimersByTime(1_000);
    await settle();

    expect(prompts).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[deck] wake for ws-owner dropped: pending decision');
    expect(logs[0]).toContain('2 events');
    expect(logs[0]).toContain('1 delegated held for replay: wtask-1');
  });

  it('says "0 delegated" when only ambient noise was dropped', async () => {
    const { c, logs } = mk({ pending: () => true });
    c.push(stop({ seq: 1 }));
    vi.advanceTimersByTime(1_000);
    await settle();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('(0 delegated)');
  });

  it('rate-limits the line to one per minute per workspace', async () => {
    const { c, logs, tick } = mk({ pending: () => true });
    c.push(stop({ seq: 1, ptyId: 'pty-a' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    tick(30_000);
    c.push(stop({ seq: 2, ptyId: 'pty-b' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(logs).toHaveLength(1);

    tick(31_000);
    c.push(stop({ seq: 3, ptyId: 'pty-c' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(logs).toHaveLength(2);
  });

  it('logs a blocked level snapshot too', () => {
    const { c, logs } = mk({ pending: () => true });
    const snapshot: FleetSnapshot = {
      workspaceId: 'ws-owner',
      ts: 0,
      panes: [{ ptyId: 'pty-a', agentName: 'claude', agentStatus: 'complete', isActivePane: true }],
    };
    c.flushSnapshot('ws-owner', snapshot);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[deck] snapshot wake for ws-owner dropped: pending decision');
  });
});

describe('delegated work survives a pending decision', () => {
  it('holds the task-tagged events and flushes them once the decision is answered', async () => {
    let pending = true;
    const { c, prompts, logs } = mk({ pending: () => pending });
    c.push(stop({ seq: 1, ptyId: 'pty-worker', task: TASK }));
    c.push(stop({ seq: 2, ptyId: 'pty-shell' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
    expect(logs).toHaveLength(1);

    // The human answers; the resolve kicks a resume turn whose onIdle is this.
    pending = false;
    c.notifyIdle('ws-owner');
    vi.advanceTimersByTime(1_000);
    await settle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('worker-task=wtask-1');
    // The ambient stop was still consumed — only delegated work is held.
    expect(prompts[0].prompt).not.toContain('pty-shell');
  });

  it('does not advance the watermark past a held delegated event', async () => {
    const { c } = mk({ pending: () => true });
    c.push(stop({ seq: 4, ptyId: 'pty-worker', task: TASK }));
    c.push(stop({ seq: 9, ptyId: 'pty-shell' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    // Consuming seq 9 would have pruned the held seq 4 with it.
    expect(c.getWatermark('ws-owner')).toBeLessThan(4);
    expect(c.getPhase('ws-owner')).toBe('buffering');
  });

  it('is unchanged when nothing was delegated: the buffer is consumed', async () => {
    let pending = true;
    const { c, prompts } = mk({ pending: () => pending });
    c.push(stop({ seq: 1 }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(c.getWatermark('ws-owner')).toBe(1);

    pending = false;
    c.notifyIdle('ws-owner');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
  });
});
