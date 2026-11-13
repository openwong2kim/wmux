// Stored local deliveries (pendingDeliveries.ts): each text once, bounded, typed
// oldest first one per pass, and dropped when their task ends, their pane
// goes, their agent changes or they expire.
import { describe, expect, it } from 'vitest';
import type { GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import {
  PENDING_DELIVERY_TTL_MS,
  PENDING_PER_PANE_CAP,
  PENDING_PER_TASK_CAP,
  PENDING_TASK_ROW_GRACE_MS,
  PENDING_TOTAL_CAP,
  PendingDeliveries,
  withdrawStoredDeliveries,
  type PendingDelivery,
  type PendingTaskState,
} from '../pendingDeliveries';

function harness(opts: { result?: GatedSubmitResult; state?: PendingTaskState; submit?: (entry: PendingDelivery) => Promise<GatedSubmitResult> } = {}) {
  let t = 1_000_000;
  const typed: string[] = [];
  const logs: string[] = [];
  let timers = 0;
  const live = { result: opts.result ?? ({ ok: true } as GatedSubmitResult), state: ('state' in opts ? opts.state : 'open') as PendingTaskState };
  const reads: string[] = [];
  const queue = new PendingDeliveries({
    submit: async (entry) => {
      const result = opts.submit ? await opts.submit(entry) : live.result;
      if (result.ok) typed.push(entry.text);
      return result;
    },
    taskState: async (entry) => {
      reads.push(entry.ptyId);
      return live.state;
    },
    log: (line) => logs.push(line),
    now: () => t,
    setTimer: () => {
      timers++;
      return { cancel: () => { timers--; } };
    },
  });
  const entry = (taskId: string, ptyId = 'pty-1', text = `text ${taskId}`): PendingDelivery => ({
    taskId, ptyId, text, agent: 'claude', opts: { senderTaskIds: [taskId] }, agentName: 'Claude Code', incarnationId: 'inc-1', sessionStartAt: null, storedAt: t, reason: 'gate_unavailable',
  });
  return { queue, typed, logs, live, reads, entry, advance: (ms: number) => { t += ms; }, timers: () => timers };
}

describe('PendingDeliveries', () => {
  it('keeps the same text for the same task and pane once, and every other message in order', async () => {
    const h = harness();
    h.queue.store(h.entry('t1', 'pty-1', 'body'));
    h.queue.store(h.entry('t1', 'pty-1', 'body'));
    expect(h.queue.size).toBe(1);
    h.queue.store(h.entry('t1', 'pty-1', 'follow-up'));
    h.queue.store(h.entry('t1', 'pty-2', 'body'));
    expect(h.queue.size).toBe(3);
    expect(h.queue.heldFor('pty-1', 't1')?.text).toBe('body');
    await h.queue.retry('pty-1');
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual(['body', 'follow-up']);
    expect(h.queue.size).toBe(1);
  });

  it('types a pane\'s entries oldest first, one per pass', async () => {
    const h = harness();
    for (const id of ['t1', 't2', 't3']) h.queue.store(h.entry(id));
    await Promise.all([h.queue.retry('pty-1'), h.queue.retry('pty-1')]);
    expect(h.typed).toEqual(['text t1']);
    await h.queue.sweep();
    await h.queue.sweep();
    expect(h.typed).toEqual(['text t1', 'text t2', 'text t3']);
  });

  it('a refused retry keeps the entry for the next pass', async () => {
    const h = harness({ result: { ok: false, reason: 'user_typing', detail: 'typing' } });
    h.queue.store(h.entry('t1'));
    await h.queue.retry('pty-1');
    expect(h.queue.size).toBe(1);
    h.live.result = { ok: true };
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual(['text t1']);
  });

  it('drops the oldest past the per-pane and the total cap', () => {
    const h = harness();
    for (let i = 0; i <= PENDING_PER_PANE_CAP; i++) h.queue.store(h.entry(`a${i}`, 'pty-a'));
    expect(h.queue.size).toBe(PENDING_PER_PANE_CAP);
    expect(h.logs.some((l) => l.includes('"a0"') && l.endsWith('cap; the task stays readable with a2a_task_query'))).toBe(true);
    const h2 = harness();
    for (let i = 0; i <= PENDING_TOTAL_CAP; i++) h2.queue.store(h2.entry(`b${i}`, `pty-${i}`));
    expect(h2.queue.size).toBe(PENDING_TOTAL_CAP);
    expect(h2.logs.some((l) => l.includes('"b0"') && l.includes(': cap;'))).toBe(true);
  });

  it('drops an entry past its expiry', async () => {
    const h = harness();
    h.queue.store(h.entry('t1'));
    h.advance(PENDING_DELIVERY_TTL_MS);
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual([]);
    expect(h.queue.size).toBe(0);
    expect(h.logs.at(-1)).toContain(': expired;');
  });

  it('drops an entry whose task is listed as ended at once', async () => {
    const h = harness({ state: 'ended' });
    h.queue.store(h.entry('t1'));
    await h.queue.retry('pty-1');
    expect(h.queue.size).toBe(0);
    expect(h.logs.at(-1)).toContain(': task ended;');
  });

  it('drops an entry whose task never appeared, once the grace for a row still being written is over', async () => {
    const h = harness({ state: 'missing' });
    h.queue.store(h.entry('t1'));
    await h.queue.retry('pty-1');
    expect(h.queue.size).toBe(1);
    h.advance(PENDING_TASK_ROW_GRACE_MS);
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual([]);
    expect(h.queue.size).toBe(0);
    expect(h.logs.at(-1)).toContain(': task ended;');
  });

  it('drops when the pane stays gone past the grace, and keeps when the task cannot be read', async () => {
    const unknown = harness({ state: null });
    unknown.queue.store(unknown.entry('t1'));
    await unknown.queue.retry('pty-1');
    expect(unknown.queue.size).toBe(1);
    const gone = harness({ state: 'pane gone' });
    gone.queue.store(gone.entry('t1'));
    // A window reload can read as ownerless for a moment.
    await gone.queue.retry('pty-1');
    expect(gone.queue.size).toBe(1);
    gone.live.state = 'open';
    gone.live.result = { ok: false, reason: 'gate_unavailable', detail: 'x' };
    await gone.queue.retry('pty-1');
    gone.live.state = 'pane gone';
    gone.advance(PENDING_TASK_ROW_GRACE_MS);
    await gone.queue.retry('pty-1');
    expect(gone.queue.size).toBe(1);
    gone.advance(PENDING_TASK_ROW_GRACE_MS);
    await gone.queue.retry('pty-1');
    expect(gone.queue.size).toBe(0);
    expect(gone.logs.at(-1)).toContain(': pane gone;');
  });

  it('the same text stored again takes the pane agent as it is now, keeping its place', () => {
    const h = harness();
    h.queue.store(h.entry('t1', 'pty-1', 'first'));
    h.queue.store(h.entry('t2', 'pty-1', 'second'));
    h.queue.store({ ...h.entry('t1', 'pty-1', 'first'), incarnationId: 'inc-2', sessionStartAt: 5 });
    const kept = h.queue.heldFor('pty-1', 't1');
    expect(kept).toMatchObject({ incarnationId: 'inc-2', sessionStartAt: 5 });
    expect(h.queue.size).toBe(2);
  });

  it('a pane gone past the grace drops all of its entries at once', async () => {
    const h = harness({ state: 'pane gone' });
    for (const id of ['t1', 't2', 't3']) h.queue.store(h.entry(id));
    await h.queue.retry('pty-1');
    h.advance(PENDING_TASK_ROW_GRACE_MS);
    await h.queue.retry('pty-1');
    expect(h.queue.size).toBe(0);
  });

  it('a withdrawn entry is no longer kept while its retry runs', async () => {
    let release: (r: GatedSubmitResult) => void = () => undefined;
    let keptDuring: boolean | undefined;
    const h = harness({
      submit: (entry) => new Promise((resolve) => {
        release = (r) => { keptDuring = h.queue.isKept(entry); resolve(r); };
      }),
    });
    h.queue.store(h.entry('t1'));
    const running = h.queue.retry('pty-1');
    await Promise.resolve();
    await Promise.resolve();
    withdrawStoredDeliveries('t1');
    release({ ok: false, reason: 'guard_refused', detail: 'withdrawn' });
    await running;
    expect(keptDuring).toBe(false);
    expect(h.queue.size).toBe(0);
  });

  it('the same text stored while it is being typed stays one entry, typed once', async () => {
    let release: (r: GatedSubmitResult) => void = () => undefined;
    const h = harness({ submit: () => new Promise((resolve) => { release = resolve; }) });
    h.queue.store(h.entry('t1'));
    const running = h.queue.retry('pty-1');
    await Promise.resolve();
    await Promise.resolve();
    h.queue.store(h.entry('t1'));
    release({ ok: true });
    await running;
    expect(h.typed).toEqual(['text t1']);
    expect(h.queue.size).toBe(0);
  });

  it('a kept new task whose conversation was already cleared is typed next time without clearing again', async () => {
    const seen: PendingDelivery['opts'][] = [];
    const results: GatedSubmitResult[] = [{ ok: false, reason: 'gate_unavailable', detail: 'x', freshContextApplied: true }, { ok: true }];
    const h = harness({ submit: async (entry) => { seen.push({ ...entry.opts }); return results.shift() as GatedSubmitResult; } });
    h.queue.store({ ...h.entry('t1'), opts: { newTask: true, taskId: 't1', keepContext: 'open_a2a_task', senderTaskIds: ['t1'] } });
    await h.queue.retry('pty-1');
    await h.queue.retry('pty-1');
    expect(seen[0]).toMatchObject({ newTask: true });
    expect(seen[1]).toEqual({ taskId: 't1', senderTaskIds: ['t1'] });
    expect(h.typed).toEqual(['text t1']);
  });

  it('past the per-task cap a task drops its own oldest, never another sender\'s', () => {
    const h = harness();
    h.queue.store(h.entry('other', 'pty-1', 'theirs'));
    for (let i = 0; i < PENDING_PER_PANE_CAP + 2; i++) h.queue.store(h.entry('burst', 'pty-1', `mine ${i}`));
    expect(h.queue.heldFor('pty-1', 'other')?.text).toBe('theirs');
    expect(h.queue.size).toBe(1 + PENDING_PER_TASK_CAP);
    expect(h.queue.heldFor('pty-1', 'burst')?.text).toBe(`mine ${PENDING_PER_PANE_CAP + 2 - PENDING_PER_TASK_CAP}`);
  });

  it('drops a pane\'s entries when its agent ends, and a task\'s when its send is withdrawn', () => {
    const h = harness();
    h.queue.store(h.entry('t1', 'pty-1'));
    h.queue.store(h.entry('t2', 'pty-2'));
    h.queue.dropPane('pty-1', 'agent changed');
    expect(h.queue.heldFor('pty-1', 't1')).toBeUndefined();
    expect(h.logs.at(-1)).toContain(': agent changed;');
    withdrawStoredDeliveries('t2');
    expect(h.queue.size).toBe(0);
    expect(h.logs.at(-1)).toContain(': withdrawn;');
  });

  it('drops when the gate finds another agent session in the pane', async () => {
    const h = harness({ result: { ok: false, reason: 'agent_changed', detail: 'changed' } });
    h.queue.store(h.entry('t1'));
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual([]);
    expect(h.queue.size).toBe(0);
    expect(h.logs.at(-1)).toContain(': agent changed;');
  });

  it('reads the task state once per pane per pass, whatever the pane holds', async () => {
    const h = harness({ result: { ok: false, reason: 'gate_unavailable', detail: 'x' } });
    for (const id of ['t1', 't2', 't3']) h.queue.store(h.entry(id, 'pty-1'));
    h.queue.store(h.entry('t4', 'pty-2'));
    await h.queue.sweep();
    expect(h.reads.sort()).toEqual(['pty-1', 'pty-2']);
  });

  it('drops an entry whose refusal wrote into the pane or will not pass by waiting', async () => {
    for (const result of [
      { ok: false, reason: 'fresh_context_timeout', detail: 'x' },
      { ok: false, reason: 'user_typing', detail: 'x', pasted: true, cleared: true },
      { ok: false, reason: 'guard_refused', detail: 'x' },
      { ok: false, reason: 'write_failed', detail: 'x' },
    ] satisfies GatedSubmitResult[]) {
      const h = harness({ result });
      h.queue.store(h.entry('t1'));
      await h.queue.retry('pty-1');
      expect(h.queue.size).toBe(0);
      expect(h.logs.at(-1)).toContain(`: refused (${result.reason});`);
    }
  });

  it('a text left in the composer is not typed again', async () => {
    const h = harness({ result: { ok: false, reason: 'approval_pending', detail: 'x', pasted: true } });
    h.queue.store(h.entry('t1'));
    await h.queue.retry('pty-1');
    expect(h.queue.size).toBe(0);
  });

  it('runs its sweep timer only while entries are kept', async () => {
    const h = harness();
    expect(h.timers()).toBe(0);
    h.queue.store(h.entry('t1'));
    h.queue.store(h.entry('t2'));
    expect(h.timers()).toBe(1);
    await h.queue.sweep();
    await h.queue.sweep();
    expect(h.timers()).toBe(0);
  });
});
