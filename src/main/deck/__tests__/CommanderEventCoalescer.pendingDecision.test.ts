// Wave 3, finding 12 — a pending decision was a SILENT kill switch.
//
// A decision left unanswered from a previous app session blocked every wake of
// the owner workspace for twenty minutes. Nothing said so: no log line, and the
// worker stops routed to the owner (tagged `task`) were consumed on the way in,
// so they were gone even after the human answered. Two properties are pinned
// here: the block is announced (once per window, and again for a NEW decision),
// and delegated work is PARKED DURABLY rather than dropped or held in RAM —
// the buffer keeps one event per (pane, kind), a human send clears it, and the
// decision that blocked the wake is exactly what outlives a restart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommanderEventCoalescer, type CoalescerInput } from '../CommanderEventCoalescer';
import { DEFAULT_AUTONOMY } from '../deckAutonomyStore';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

interface Opts {
  pending: () => boolean;
  decisionId?: () => string | null;
  backlog?: CoalescerInput[];
}

function mk(opts: Opts) {
  const prompts: { ws: string; prompt: string }[] = [];
  const logs: string[] = [];
  const parked: CoalescerInput[] = [];
  const acks: number[] = [];
  const backlog = opts.backlog ?? [];
  let clock = 0;
  const c = new CommanderEventCoalescer({
    runTurn: async (ws, prompt) => {
      prompts.push({ ws, prompt });
      return { ok: true };
    },
    isBusy: () => false,
    // 'all' so an UNTAGGED event is a real wake here: these tests are about the
    // decision gate, which sits above the wake policy, and the fail-closed
    // default ('none') would consume the ambient events for a second reason.
    getAutonomy: () => ({ ...DEFAULT_AUTONOMY, wakePolicy: 'all' as const }),
    hasPendingDecision: opts.pending,
    getPendingDecisionId: opts.decisionId ?? (() => 'dec-1'),
    // The real port is durable (the ledger's orphan backlog); here it is the
    // same list `peekOrphanBacklog` reads, so a park is observable as a replay.
    parkDelegated: (_ws, events) => {
      for (const e of events) {
        if (!backlog.some((b) => b.seq === e.seq)) {
          parked.push(e);
          backlog.push(e);
        }
      }
    },
    peekOrphanBacklog: () => [...backlog],
    ackOrphanBacklog: (_ws, upToSeq) => {
      acks.push(upToSeq);
      for (let i = backlog.length - 1; i >= 0; i--) if (backlog[i].seq <= upToSeq) backlog.splice(i, 1);
    },
    log: (line) => logs.push(line),
    now: () => clock,
    debounceMs: 1_000,
  });
  return { c, prompts, logs, parked, backlog, acks, tick: (ms: number) => { clock += ms; } };
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
  it('names the workspace, the decision, the event count and the delegated task ids', async () => {
    const { c, prompts, logs } = mk({ pending: () => true });
    c.push(stop({ seq: 1, ptyId: 'pty-a', task: TASK }));
    c.push(stop({ seq: 2, ptyId: 'pty-b' }));
    vi.advanceTimersByTime(1_000);
    await settle();

    expect(prompts).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[deck] wake for ws-owner dropped: pending decision dec-1');
    expect(logs[0]).toContain('2 events');
    expect(logs[0]).toContain('1 delegated parked for replay: wtask-1');
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

  it('logs a DIFFERENT decision immediately, without waiting out the window', async () => {
    let id = 'dec-1';
    const { c, logs, tick } = mk({ pending: () => true, decisionId: () => id });
    c.push(stop({ seq: 1, ptyId: 'pty-a' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(logs).toHaveLength(1);

    tick(1_000);
    id = 'dec-2';
    c.push(stop({ seq: 2, ptyId: 'pty-b' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('pending decision dec-2');
  });

  it('an accepted flush re-arms the line, so the next block is announced', async () => {
    let pending = true;
    const { c, logs, tick } = mk({ pending: () => pending });
    c.push(stop({ seq: 1, ptyId: 'pty-a' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(logs).toHaveLength(1);

    pending = false;
    c.push(stop({ seq: 2, ptyId: 'pty-b' }));
    vi.advanceTimersByTime(1_000);
    await settle();

    pending = true;
    tick(1_000);
    c.push(stop({ seq: 3, ptyId: 'pty-c' }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(logs).toHaveLength(2);
  });

  it('logs a blocked level snapshot, but says nothing when nothing was blocked', () => {
    const { c, logs } = mk({ pending: () => true });
    const snap = (agentStatus: 'complete' | 'running'): FleetSnapshot => ({
      workspaceId: 'ws-owner',
      ts: 0,
      panes: [{ ptyId: 'pty-a', agentName: 'claude', agentStatus, isActivePane: true }],
    });

    // A quiescent fleet with an empty buffer is not a blocked wake — no line,
    // and no rate-limit slot burned on it.
    c.flushSnapshot('ws-owner', snap('running'));
    expect(logs).toHaveLength(0);

    c.flushSnapshot('ws-owner', snap('complete'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[deck] snapshot wake for ws-owner dropped: pending decision dec-1');
  });
});

describe('delegated work is parked durably, not dropped', () => {
  it('parks the task-tagged events, consumes the ambient ones, and advances the watermark', async () => {
    const { c, prompts, parked } = mk({ pending: () => true });
    c.push(stop({ seq: 4, ptyId: 'pty-worker', task: TASK }));
    c.push(stop({ seq: 9, ptyId: 'pty-shell' }));
    vi.advanceTimersByTime(1_000);
    await settle();

    expect(prompts).toHaveLength(0);
    expect(parked.map((e) => e.seq)).toEqual([4]);
    expect(parked[0].task).toEqual(TASK);
    expect(parked[0].workspaceId).toBe('ws-owner');
    // Normal consume: nothing is left half-in the buffer.
    expect(c.getWatermark('ws-owner')).toBe(9);
    expect(c.getPhase('ws-owner')).toBe('idle');
  });

  it('the resume after a resolve delivers the parked event exactly once and acks it', async () => {
    let pending = true;
    const { c, prompts, backlog, acks } = mk({ pending: () => pending });
    c.push(stop({ seq: 4, ptyId: 'pty-worker', task: TASK }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(backlog).toHaveLength(1);

    // The human answers: DECK_DECISION_RESOLVE calls this before the resume turn.
    pending = false;
    c.notifyDecisionResolved('ws-owner');
    vi.advanceTimersByTime(1_000);
    await settle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('worker-task=wtask-1');
    expect(acks).toEqual([4]);
    expect(backlog).toHaveLength(0);

    // And it is not delivered a second time on the next idle.
    c.notifyIdle('ws-owner');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
  });

  it('a human send between the park and the resolve does not lose it', async () => {
    let pending = true;
    const { c, prompts, backlog, parked } = mk({ pending: () => pending });
    c.push(stop({ seq: 4, ptyId: 'pty-worker', task: TASK }));
    vi.advanceTimersByTime(1_000);
    await settle();

    // A human send clears the buffer and advances the watermark — which is why
    // the buffer could never have been the holding place. The backlog survives,
    // and re-parking it does not duplicate the row.
    c.notifyHumanSend('ws-owner');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(backlog).toHaveLength(1);
    expect(parked).toHaveLength(1);

    pending = false;
    c.notifyDecisionResolved('ws-owner');
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain('worker-task=wtask-1');
  });

  it('resolving resets the auto-wake budget a long-pending decision burned', async () => {
    let pending = false;
    const { c } = mk({ pending: () => pending });
    // Five accepted ambient wakes exhaust the default budget.
    for (let seq = 1; seq <= 5; seq++) {
      c.push(stop({ seq, ptyId: `pty-${seq}` }));
      vi.advanceTimersByTime(1_000);
      await settle();
    }
    expect(c.getWakeBudgetRemaining('ws-owner')).toBe(0);

    pending = true;
    pending = false;
    c.notifyDecisionResolved('ws-owner');
    expect(c.getWakeBudgetRemaining('ws-owner')).toBe(5);
  });

  it('is a no-op without a park port: the events are consumed as before', async () => {
    const prompts: string[] = [];
    const c = new CommanderEventCoalescer({
      runTurn: async (_ws, p) => {
        prompts.push(p);
        return { ok: true };
      },
      isBusy: () => false,
      getAutonomy: () => ({ ...DEFAULT_AUTONOMY }),
      hasPendingDecision: () => true,
      debounceMs: 1_000,
    });
    c.push(stop({ seq: 1, task: TASK }));
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(prompts).toHaveLength(0);
    expect(c.getWatermark('ws-owner')).toBe(1);
  });
});
