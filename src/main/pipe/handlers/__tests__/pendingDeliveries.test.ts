// Stored local deliveries (pendingDeliveries.ts): one per task, bounded, typed
// oldest first one per pass, and dropped when their task ends, their pane
// goes, their agent changes or they expire.
import { describe, expect, it } from 'vitest';
import type { GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import {
  PENDING_DELIVERY_TTL_MS,
  PENDING_PER_PANE_CAP,
  PENDING_TASK_ROW_GRACE_MS,
  PENDING_TOTAL_CAP,
  PendingDeliveries,
  type PendingDelivery,
  type PendingTaskState,
} from '../pendingDeliveries';

function harness(opts: { result?: GatedSubmitResult; state?: PendingTaskState; session?: string | null } = {}) {
  let t = 1_000_000;
  const typed: string[] = [];
  const logs: string[] = [];
  let timers = 0;
  const live = { result: opts.result ?? ({ ok: true } as GatedSubmitResult), state: ('state' in opts ? opts.state : 'open') as PendingTaskState, session: opts.session === undefined ? 'inc-1' : opts.session };
  const queue = new PendingDeliveries({
    submit: async (entry) => {
      if (live.result.ok) typed.push(entry.text);
      return live.result;
    },
    taskState: async () => live.state,
    agentSession: async () => live.session,
    log: (line) => logs.push(line),
    now: () => t,
    setTimer: () => {
      timers++;
      return { cancel: () => { timers--; } };
    },
  });
  const entry = (taskId: string, ptyId = 'pty-1', text = `text ${taskId}`): PendingDelivery => ({
    taskId, ptyId, text, agent: 'claude', opts: { senderTaskIds: [taskId] }, agentName: 'Claude Code', incarnationId: 'inc-1', storedAt: t,
  });
  return { queue, typed, logs, live, entry, advance: (ms: number) => { t += ms; }, timers: () => timers };
}

describe('PendingDeliveries', () => {
  it('keeps one entry per task: a later one replaces it', async () => {
    const h = harness();
    h.queue.store(h.entry('t1', 'pty-1', 'first'));
    h.queue.store(h.entry('t1', 'pty-1', 'second'));
    expect(h.queue.size).toBe(1);
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual(['second']);
    expect(h.queue.size).toBe(0);
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

  it('drops when the task ended, after the grace for a row still being written', async () => {
    const h = harness({ state: 'ended' });
    h.queue.store(h.entry('t1'));
    await h.queue.retry('pty-1');
    expect(h.queue.size).toBe(1);
    h.advance(PENDING_TASK_ROW_GRACE_MS);
    await h.queue.retry('pty-1');
    expect(h.typed).toEqual([]);
    expect(h.queue.size).toBe(0);
    expect(h.logs.at(-1)).toContain(': task ended;');
  });

  it('drops when the pane is gone, and keeps when the task cannot be read', async () => {
    const unknown = harness({ state: null });
    unknown.queue.store(unknown.entry('t1'));
    await unknown.queue.retry('pty-1');
    expect(unknown.queue.size).toBe(1);
    const gone = harness({ state: 'pane gone' });
    gone.queue.store(gone.entry('t1'));
    await gone.queue.retry('pty-1');
    expect(gone.queue.size).toBe(0);
    expect(gone.logs.at(-1)).toContain(': pane gone;');
  });

  it('drops when the pane\'s agent session changed, before or during the write', async () => {
    const before = harness({ session: 'inc-2' });
    before.queue.store(before.entry('t1'));
    await before.queue.retry('pty-1');
    expect(before.typed).toEqual([]);
    expect(before.logs.at(-1)).toContain(': agent changed;');

    const during = harness({ result: { ok: false, reason: 'agent_changed', detail: 'changed' } });
    during.queue.store(during.entry('t1'));
    await during.queue.retry('pty-1');
    expect(during.queue.size).toBe(0);

    const unread = harness({ session: null });
    unread.queue.store(unread.entry('t1'));
    await unread.queue.retry('pty-1');
    expect(unread.queue.size).toBe(1);
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
