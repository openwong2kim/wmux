// One budget for bots and workers: a bot's new worker past it waits for a
// slot, first come first served, and a stop ends the wait.
import { describe, expect, it, vi } from 'vitest';
import { countOpenBotWorkers } from '../openBotWorkers';
import { WAKE_LIMITS } from '../../../shared/wake';
import { AgentSlots, IdleSnapshot, SLOT_GRANT_MAX_MS, SLOT_HOLDERS_SHOWN_MAX, SLOT_ROW_GRACE_MS, paneRunsNoAgent, paneShowsWork, rowHoldsAgentSlot, slotHolderArgs, type AgentSlotPorts, type SlotLiveness } from '../agentSlots';

function slots(over: Partial<AgentSlotPorts> & { bots?: () => number; workers?: () => number } = {}) {
  let now = 0;
  const onWaiting = vi.fn();
  const s = new AgentSlots({
    cap: () => 3,
    runningBots: over.bots ?? (() => 1),
    liveWorkers: over.workers ?? (() => 0),
    onWaiting,
    now: () => now,
    pollMs: 60_000,
    ...over,
  });
  return { s, onWaiting, advance: (ms: number) => { now += ms; } };
}
const w = (taskId: string) => ({ taskId, title: taskId, botId: 'bot-0000000a', ownerWorkspaceId: 'ws-1' });

describe('AgentSlots', () => {
  it('grants under the cap and counts granted launches until they register', async () => {
    let workers = 0;
    const { s, onWaiting } = slots({ workers: () => workers });
    const a = await s.acquire(w('a'));
    const b = await s.acquire(w('b'));
    expect(a.ok && b.ok).toBe(true);
    expect(s.inUse()).toBe(3); // 1 bot + 2 granted
    let third: unknown = null;
    void s.acquire(w('c')).then((g) => { third = g; });
    await Promise.resolve();
    expect(third).toBeNull();
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(s.waiting().map((x) => x.taskId)).toEqual(['c']);
    // a registers: counted as a live worker, its booking released; still full.
    workers = 1;
    if (a.ok) a.release();
    await Promise.resolve();
    expect(third).toBeNull();
    // b's launch gives up: a slot frees and c starts.
    if (b.ok) b.release();
    await vi.waitFor(() => expect(third).toMatchObject({ ok: true }), { timeout: 5_000 });
    expect(s.waiting()).toEqual([]);
  });

  it('serves waiters in order, and a new start never jumps the queue', async () => {
    let bots = 3;
    const { s } = slots({ bots: () => bots });
    const order: string[] = [];
    void s.acquire(w('first')).then(() => order.push('first'));
    void s.acquire(w('second')).then(() => order.push('second'));
    bots = 2;
    expect(s.tryAcquire()).toBeNull(); // others wait first
    s.kick();
    await vi.waitFor(() => expect(order).toEqual(['first']), { timeout: 5_000 });
    bots = 1;
    s.kick();
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']), { timeout: 5_000 });
  });

  it('ends a wait unlaunched when the launch is no longer wanted, or after the longest wait', async () => {
    const { s, advance } = slots({ bots: () => 3, maxWaitMs: 1_000 });
    let stopped: string | null = null;
    const a = s.acquire(w('a'), () => stopped);
    const b = s.acquire(w('b'));
    stopped = 'the owner stopped this bot';
    s.kick();
    expect(await a).toEqual({ ok: false, reason: 'the owner stopped this bot' });
    advance(1_000);
    s.kick();
    expect(await b).toMatchObject({ ok: false });
  });

  it('a broken count or cap never grants past one agent', async () => {
    const { s } = slots({ cap: () => Number.NaN, bots: () => 0 });
    expect((await s.acquire(w('a'))).ok).toBe(true);
    expect(s.tryAcquire()).toBeNull();
    s.dispose();
    expect(await s.acquire(w('b'))).toMatchObject({ ok: false });
  });
});

describe('AgentSlots held workers', () => {
  it('a spawned worker with no ledger row keeps its slot while its workspace lives', async () => {
    const live = new Set<string>();
    const { s } = slots({ bots: () => 0, stillHeld: (ws) => live.has(ws) });
    const g = await s.acquire(w('a'));
    if (!g.ok) throw new Error('no grant');
    live.add('ws-task');
    g.hold('ws-task');
    expect(s.inUse()).toBe(1);
    g.release(); // already handed over: no double release
    expect(s.inUse()).toBe(1);
    live.delete('ws-task');
    expect(s.inUse()).toBe(0);
  });

  it('without a way to tell, a hold releases the slot', async () => {
    const { s } = slots({ bots: () => 0 });
    const g = await s.acquire(w('a'));
    if (g.ok) g.hold('ws-task');
    expect(s.inUse()).toBe(0);
  });
});

describe('AgentSlots grants (review fixes, PR #2164)', () => {
  it('a grant neither released nor held stops counting after SLOT_GRANT_MAX_MS', async () => {
    const { s, advance } = slots({ bots: () => 0, log: () => undefined });
    const g = await s.acquire(w('a'));
    expect(g.ok).toBe(true);
    expect(s.inUse()).toBe(1);
    advance(SLOT_GRANT_MAX_MS - 1);
    expect(s.inUse()).toBe(1);
    advance(1);
    expect(s.inUse()).toBe(0);
    // A late release of it changes nothing.
    if (g.ok) g.release();
    expect(s.inUse()).toBe(0);
  });

  it('lists a bot\'s launches under way: waiting or granted, until released', async () => {
    const { s } = slots({ bots: () => 0 });
    const a = await s.acquire(w('a'));
    await s.acquire({ ...w('x'), botId: 'bot-0000000b' });
    const b = await s.acquire(w('b'));
    void s.acquire(w('c'));
    await Promise.resolve();
    expect(s.inFlight('bot-0000000a').sort()).toEqual(['a', 'b', 'c']);
    if (a.ok) a.release();
    if (b.ok) b.hold('ws-b');
    await Promise.resolve();
    expect(s.inFlight('bot-0000000a')).toEqual(['c']);
  });
});

describe('rowHoldsAgentSlot', () => {
  const now = 100 * SLOT_ROW_GRACE_MS;
  const old = now - SLOT_ROW_GRACE_MS;
  const bot = { kind: 'bot', botId: 'bot-0000000a' };
  const live: SlotLiveness = { workspaces: new Set(['ws-live', 'ws-idle']), idleWorkspaces: new Set(['ws-idle']), now };
  const row = (taskWorkspaceId: string, origin?: { kind: string; botId?: string }, updatedAt = old) =>
    ({ taskWorkspaceId, updatedAt, ...(origin ? { dispatch: { origin } } : {}) });

  it('a bot worker whose workspace is open and whose agent runs holds a slot', () => {
    expect(rowHoldsAgentSlot(row('ws-live', bot), live)).toBe(true);
  });

  it('the owner\'s and the orchestrator\'s fan-outs, and rows with no dispatch, never count', () => {
    expect(rowHoldsAgentSlot(row('ws-live', { kind: 'orchestrator' }), live)).toBe(false);
    expect(rowHoldsAgentSlot(row('ws-live', { kind: 'pane' }), live)).toBe(false);
    // A row from before dispatch existed (or a stray test fixture).
    expect(rowHoldsAgentSlot(row('ws-task-1'), live)).toBe(false);
  });

  it('an open row whose workspace is gone, or whose agent exited, holds nothing', () => {
    expect(rowHoldsAgentSlot(row('ws-gone', bot), live)).toBe(false);
    expect(rowHoldsAgentSlot(row('ws-idle', bot), live)).toBe(false);
  });

  it('a completed, cancelled or failed row never holds a slot, even recent and with its workspace open', () => {
    for (const status of ['completed', 'cancelled', 'failed'] as const) {
      expect(rowHoldsAgentSlot({ ...row('ws-live', bot, now - 1_000), status }, live), status).toBe(false);
      expect(rowHoldsAgentSlot({ ...row('ws-live', bot), status }, null), status).toBe(false);
    }
    expect(rowHoldsAgentSlot({ ...row('ws-live', bot), status: 'review_requested' }, live)).toBe(true);
  });

  it('a recent row counts while its worker comes up; with nothing known every bot row counts', () => {
    expect(rowHoldsAgentSlot(row('ws-gone', bot, now - 1_000), live)).toBe(true);
    expect(rowHoldsAgentSlot(row('ws-gone', bot), { ...live, workspaces: null })).toBe(true);
    expect(rowHoldsAgentSlot(row('ws-gone', bot), null)).toBe(true);
  });

  it('stale and foreign rows no longer starve the bots: only the live bot worker counts', async () => {
    const rows = [
      row('ws-task-1'), row('ws-task-3'), row('ws-task-4'), // leaked fixtures: no dispatch
      row('ws-gone-1', { kind: 'orchestrator' }), row('ws-gone-2', { kind: 'orchestrator' }),
      row('ws-gone-3', bot), row('ws-idle', bot),
      row('ws-live', bot),
    ];
    const s = new AgentSlots({ cap: () => 2, runningBots: () => 1, liveWorkers: () => rows.filter((r) => rowHoldsAgentSlot(r, live)).length, pollMs: 60_000 });
    expect(s.inUse()).toBe(2);
    rows.pop();
    const g = await s.acquire({ taskId: 't', title: 't', botId: 'bot-0000000a', ownerWorkspaceId: 'ws-1' });
    expect(g.ok).toBe(true);
  });
});

describe('paneRunsNoAgent (F22: after a cold start)', () => {
  it('a pane the daemon respawned at its restart, with no agent seen since, runs none', () => {
    expect(paneRunsNoAgent({ state: 'detached', recoveredAgentUnconfirmed: true })).toBe(true);
    // An agent seen there again holds it.
    expect(paneRunsNoAgent({ state: 'detached', recoveredAgentUnconfirmed: true, agentProcessAlive: true })).toBe(false);
    // A launch typed there before its agent is confirmed holds it too.
    expect(paneRunsNoAgent({ state: 'detached', recoveredAgentUnconfirmed: true, commandRunning: true })).toBe(false);
  });

  it('gone, without a live PTY, or seen to exit runs none; never attributed is not known dead', () => {
    expect(paneRunsNoAgent(undefined)).toBe(true);
    expect(paneRunsNoAgent({ state: 'dead' })).toBe(true);
    expect(paneRunsNoAgent({ state: 'suspended' })).toBe(true);
    expect(paneRunsNoAgent({ state: 'attached', agentProcessAlive: false })).toBe(true);
    // An older daemon that does not say: kept, as before.
    expect(paneRunsNoAgent({ state: 'attached' })).toBe(false);
    expect(paneRunsNoAgent({ state: 'detached', agentProcessAlive: true })).toBe(false);
  });

  it('after a cold start the bot\'s worker in review holds no slot, so a new worker gets one', async () => {
    const now = 100 * SLOT_ROW_GRACE_MS;
    const sessions = new Map([['pty-r', { state: 'detached', recoveredAgentUnconfirmed: true }]]);
    const idle = new Set(['ws-review'].filter(() => ['pty-r'].every((id) => paneRunsNoAgent(sessions.get(id)))));
    const live: SlotLiveness = { workspaces: new Set(['ws-review']), idleWorkspaces: idle, now };
    const rows = [{ taskWorkspaceId: 'ws-review', updatedAt: now - SLOT_ROW_GRACE_MS, status: 'review_requested' as const, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } }];
    const s = new AgentSlots({ cap: () => 1, runningBots: () => 0, liveWorkers: () => rows.filter((r) => rowHoldsAgentSlot(r, live)).length, pollMs: 60_000 });
    expect(s.inUse()).toBe(0);
    expect((await s.acquire({ taskId: 't', title: 't', botId: 'bot-0000000a', ownerWorkspaceId: 'ws-1' })).ok).toBe(true);
  });
});

describe('the factory-wide worker cap over paused review workers (F22)', () => {
  const now = 100 * SLOT_ROW_GRACE_MS;
  const bot = { kind: 'bot', botId: 'bot-0000000a' };
  const review = (id: string, ws: string) => ({ id, taskWorkspaceId: ws, status: 'review_requested' as const, updatedAt: now - SLOT_ROW_GRACE_MS, dispatch: { origin: bot } });
  /** What fanout.rpc admits: open (counted as openBotWorkers counts) + booked + n within the cap. */
  const admits = (rows: ReturnType<typeof review>[], live: SlotLiveness, n: number) => {
    const open = countOpenBotWorkers(rows.filter((r) => rowHoldsAgentSlot(r, live)), 'bot-0000000a', () => new Set());
    return open.factory + n <= WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS;
  };

  it('three review tasks whose workers were paused leave room for a new worker', () => {
    const rows = [review('t1', 'ws-1'), review('t2', 'ws-2'), review('t3', 'ws-3')];
    // Their WSL panes run no agent the daemon attributed: liveness alone keeps them.
    const live: SlotLiveness = { workspaces: new Set(['ws-1', 'ws-2', 'ws-3']), idleWorkspaces: new Set(), now };
    expect(admits(rows, live, 1)).toBe(false);
    expect(admits(rows, { ...live, stoppedTasks: new Set(['t1', 't2', 't3']) }, 1)).toBe(true);
  });

  it('two running workers and one paused: one more is admitted, not two', () => {
    const rows = [review('t1', 'ws-1'), review('t2', 'ws-2'), review('t3', 'ws-3')];
    const live: SlotLiveness = { workspaces: new Set(['ws-1', 'ws-2', 'ws-3']), idleWorkspaces: new Set(), stoppedTasks: new Set(['t3']), now };
    expect(admits(rows, live, 1)).toBe(true);
    expect(admits(rows, live, 2)).toBe(false);
  });

  it('a recent row whose worker was stopped since holds nothing; one never stopped still counts while it comes up', () => {
    const fresh = { ...review('t1', 'ws-gone'), updatedAt: now - 1_000 };
    const live: SlotLiveness = { workspaces: new Set(), idleWorkspaces: new Set(), now };
    expect(rowHoldsAgentSlot(fresh, live)).toBe(true);
    expect(rowHoldsAgentSlot(fresh, { ...live, stoppedTasks: new Set(['t1']) })).toBe(false);
  });

  it('a stopped task\'s worker relaunched by hand holds its slot again', () => {
    const row = review('t1', 'ws-1');
    const live: SlotLiveness = { workspaces: new Set(['ws-1']), idleWorkspaces: new Set(), stoppedTasks: new Set(['t1']), now };
    expect(rowHoldsAgentSlot(row, live)).toBe(false);
    for (const pane of [{ agentProcessAlive: true }, { commandRunning: true }]) {
      expect(paneShowsWork(pane)).toBe(true);
      expect(rowHoldsAgentSlot(row, { ...live, busyWorkspaces: new Set(['ws-1']) })).toBe(true);
    }
    expect(paneShowsWork({ commandRunning: false })).toBe(false);
  });
});

describe('slotHolderArgs', () => {
  it('names the holders in English and as values the reader\'s language words', () => {
    const r = slotHolderArgs(['구현'], ['fix login', 'add tests'], 4);
    expect(r).toEqual({
      holders: 'bot in a turn 구현; workers "fix login", "add tests"; 1 other worker starting, resumed or not yet reclaimed',
      bots: '구현', botCount: 1, workers: 'fix login\nadd tests', workerCount: 2,
    });
    expect(slotHolderArgs([], [], 0).holders).toBe('nothing the factory can name');
  });

  it('cuts each list at the shown maximum but keeps the full count', () => {
    const many = Array.from({ length: SLOT_HOLDERS_SHOWN_MAX + 2 }, (_, i) => `w${i}`);
    const r = slotHolderArgs([], many, many.length);
    expect(r.workerCount).toBe(many.length);
    expect(r.workers.split('\n')).toHaveLength(SLOT_HOLDERS_SHOWN_MAX);
    expect(r.holders).toMatch(/ and 2 more$/);
  });
});

describe('IdleSnapshot (#2255)', () => {
  it('a cap check after a quiet period sees the panes as they are now, not the previous check\'s snapshot', async () => {
    const REFRESH_MS = 10_000;
    let now = 1_000_000;
    // The fake daemon: whether each worker workspace's agent still runs.
    const agentAlive = new Map([['ws-a', true], ['ws-b', true], ['ws-c', true]]);
    // A daemon round-trip: answered on a later turn of the event loop.
    const read = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 0));
      return new Set([...agentAlive].filter(([, alive]) => !alive).map(([ws]) => ws));
    });
    const idle = new IdleSnapshot(read, REFRESH_MS, () => now);
    const rows = ['ws-a', 'ws-b', 'ws-c'].map((ws) => ({ dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } }, taskWorkspaceId: ws, updatedAt: 0 }) as never);
    // The factory-wide cap of 3: one more worker fits only below it.
    const capAllowsOneMore = async (): Promise<boolean> => {
      await idle.fresh();
      const live: SlotLiveness = { workspaces: new Set(agentAlive.keys()), idleWorkspaces: idle.get(), now };
      return rows.filter((r) => rowHoldsAgentSlot(r, live)).length + 1 <= 3;
    };

    expect(await capAllowsOneMore()).toBe(false);
    // Back to back: the throttle holds, no second daemon read.
    expect(await capAllowsOneMore()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    // Two workers pause, then minutes pass with no check at all.
    agentAlive.set('ws-b', false);
    agentAlive.set('ws-c', false);
    now += 12 * 60_000;
    expect(await capAllowsOneMore()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a failed read keeps the last snapshot and does not hold the check', async () => {
    let now = 1_000_000;
    let fail = false;
    const idle = new IdleSnapshot(async () => {
      if (fail) throw new Error('the daemon is not connected');
      return new Set(['ws-a']);
    }, 10_000, () => now);
    await idle.fresh();
    fail = true;
    now += 60_000;
    await idle.fresh();
    expect([...idle.get()]).toEqual(['ws-a']);
  });
});
