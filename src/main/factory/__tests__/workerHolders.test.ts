// One holder set for every live-worker cap (#2393): the rules over each
// input state, the four caps agreeing on the paths that used to split them,
// one regression per finding of the holder set's review rounds R1–R10, and
// the earlier fixes still holding through the set. Which task a pane or
// workspace is, and when its worker launched, come from a real launch record
// (workerSlots.ts, #2411).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holderInputsRevision } from '../holderInputs';
import type { LedgerEntry } from '../../../shared/ledger';
import { computeHolders, holderCounts, liveHolders, setHolderSource, type HolderRecord, type HolderSnapshot, type WorkerHolder } from '../workerHolders';
import { AgentSlots, SLOT_ROW_GRACE_MS } from '../agentSlots';
import { openBotWorkers } from '../openBotWorkers';
import { FanOutGuards, recordFanoutTaskPane, setFanOutGuardsForTests, stampFanoutTaskPane, taskOfWorkspace } from '../../worktask/fanoutGuards';
import { WORKER_SLOTS_FILENAME, WorkerSlots, setWorkerSlotsForTests, taskOfPane } from '../workerSlots';
import { STOPPED_BY_OWNER } from '../factoryStop';

const NOW = 10_000_000_000;
const DAY = 24 * 3_600_000;
const BOT = 'bot-0000000a';
const OWNER = 'ws-owner';

function row(id: string, over: Partial<LedgerEntry> & { bot?: boolean } = {}): LedgerEntry {
  const { bot = true, ...rest } = over;
  return {
    schemaVersion: 1,
    id,
    taskWorkspaceId: `ws-${id}`,
    ownerWorkspaceId: OWNER,
    title: id,
    status: 'working',
    rev: 3,
    updatedAt: NOW - 10 * 60_000,
    updatedBy: { kind: 'worker', workspaceId: `ws-${id}` },
    dispatch: { origin: bot ? { kind: 'bot', botId: BOT } : { kind: 'pane' } },
    ...rest,
  };
}

function record(taskId: string, over: Partial<HolderRecord> = {}): HolderRecord {
  return { taskId, botId: BOT, ownerWorkspaceId: OWNER, taskWorkspaceId: `ws-${taskId}`, title: taskId, state: 'stopped', ended: 'completed', at: NOW - 5 * 60_000, ...over };
}

function snapshot(over: Partial<HolderSnapshot> = {}): HolderSnapshot {
  const rows = over.rows ?? [];
  const read = over.read ?? 'ok';
  const reclaimable = new Set(rows.filter((r) => r.dispatch?.origin.kind === 'bot'
    && (r.status === 'completed' || r.status === 'failed' || (r.status === 'cancelled' && r.summary !== STOPPED_BY_OWNER))).map((r) => r.id));
  return {
    now: NOW,
    rows,
    reclaimable,
    catchupMs: DAY,
    workspaces: new Set(rows.map((r) => r.taskWorkspaceId)),
    ptys: new Map(rows.map((r) => [r.taskWorkspaceId, [`p-${r.id}`]])),
    stamps: new Map(rows.map((r) => [r.taskWorkspaceId, { owner: OWNER }])),
    read,
    // The last good read started a few seconds ago (none while it is down).
    ...(read === 'down' ? {} : { readAt: NOW - 5_000 }),
    idle: new Set(),
    busy: new Set(),
    agentSeen: new Set(),
    gone: new Set(),
    records: [],
    verdicted: new Set(),
    taskOfWorkspace: () => null,
    taskOfPane: () => null,
    launchAt: () => undefined,
    launchOf: () => null,
    reservations: [],
    grants: [],
    heldWorkspaces: [],
    ...over,
  };
}

const holderOf = (holders: WorkerHolder[], taskId: string): WorkerHolder | undefined => holders.find((h) => h.taskId === taskId);

describe('computeHolders — each input state × daemon read × origin', () => {
  type Case = { name: string; snap: (bot: boolean, read: HolderSnapshot['read']) => HolderSnapshot; want: (bot: boolean, read: HolderSnapshot['read']) => string };
  const ws = (id: string) => `ws-${id}`;
  // What a read shows: a stale read is the last good one; with none, nothing.
  const seen = (read: HolderSnapshot['read'], set: string[]): Set<string> => new Set(read === 'down' ? [] : set);
  const cases: Case[] = [
    {
      name: 'an open task whose agent runs',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot })], read, busy: seen(read, [ws('t')]) }),
      want: (_b, read) => (read === 'ok' ? 'held' : 'unknown'),
    },
    {
      name: 'an open task whose panes run no agent',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot })], read, idle: seen(read, [ws('t')]) }),
      want: (_b, read) => (read === 'down' ? 'unknown' : 'free'),
    },
    {
      name: 'an open task launched a minute ago',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot })], read, idle: seen(read, [ws('t')]), launchAt: () => NOW - 60_000 }),
      want: () => 'held',
    },
    {
      name: 'an open task whose workspace closed',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot })], read, workspaces: new Set(['other']) }),
      want: () => 'free',
    },
    {
      name: 'a paused worker (stopped at its report)',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'review_requested' })], read, records: [record('t', { ended: 'reported' })] }),
      want: () => 'free',
    },
    {
      name: 'a verify task with its verdict recorded',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'review_requested', dispatch: { origin: bot ? { kind: 'bot', botId: BOT } : { kind: 'pane' }, preset: 'verify' } })], read, busy: seen(read, [ws('t')]), verdicted: new Set(['t']) }),
      want: () => 'free',
    },
    {
      name: 'an ended task whose agent was seen gone (a fact)',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'completed' })], read, gone: new Set(['t']) }),
      want: () => 'free',
    },
    {
      name: 'an ended task with its workspace open and no fact',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'completed' })], read }),
      want: () => 'unknown',
    },
    {
      name: 'an ended task whose agent is seen running',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'completed' })], read, agentSeen: seen(read, [ws('t')]), gone: new Set() }),
      want: (_b, read) => (read === 'down' ? 'unknown' : 'held'),
    },
    {
      name: 'an ended task whose worker was reclaimed',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'completed' })], read, records: [record('t')] }),
      want: () => 'free',
    },
    {
      name: 'an ended task with its workspace closed and no fact, launched within the window',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'failed' })], read, workspaces: new Set(['other']), launchOf: () => ({ launchedAt: NOW - 3_600_000, origin: 'bot' }) }),
      want: (bot) => (bot ? 'unknown' : 'free'),
    },
    {
      name: 'an ended task with its workspace closed and no fact, launched before the window',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'failed', updatedAt: NOW })], read, workspaces: new Set(['other']), launchOf: () => ({ launchedAt: NOW - 2 * DAY, origin: 'bot' }) }),
      want: () => 'free',
    },
    {
      name: 'a resumed worker',
      snap: (bot, read) => snapshot({ rows: [row('t', { bot, status: 'completed' })], read, records: [record('t', { state: 'resumed' })], gone: new Set(['t']) }),
      want: () => 'held',
    },
  ];
  for (const c of cases) {
    for (const read of ['ok', 'stale', 'down'] as const) {
      for (const bot of [true, false]) {
        it(`${c.name} — read ${read}, ${bot ? 'bot' : 'owner'}`, () => {
          const holders = computeHolders(c.snap(bot, read));
          const h = holderOf(holders, 't');
          const want = c.want(bot, read);
          if (want === 'free') expect(h?.state ?? 'free').toBe('free');
          else expect(h?.state).toBe(want);
          if (h) expect(h.origin).toBe(bot ? 'bot' : 'owner');
        });
      }
    }
  }

  it('a booked task no record names yet holds every cap but the agent budget', () => {
    const holders = computeHolders(snapshot({ reservations: [{ key: 'k', ownerWorkspaceId: OWNER, botId: BOT, phase: 'spawning' }] }));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ state: 'held', reserved: true, origin: 'bot', botId: BOT });
    expect(holderCounts(holders, BOT)).toEqual({ live: 1, workers: 1, agents: 0, bot: 1, botStarting: 1 });
  });

  it('a stamped workspace with no row holds while a pane of it may run an agent, as a bot worker when its stamp says so', () => {
    const base = { stamps: new Map([['ws-x', { owner: OWNER, origin: { kind: 'bot', botId: BOT } }]]), workspaces: new Set(['ws-x']), ptys: new Map([['ws-x', ['p-x']]]) };
    expect(computeHolders(snapshot(base))[0]).toMatchObject({ taskId: 'workspace:ws-x', state: 'held', origin: 'bot', why: 'no-task-record' });
    expect(computeHolders(snapshot({ ...base, read: 'down' }))[0]).toMatchObject({ state: 'unknown' });
    // Its panes run no agent, or it has none (a workspace a resume left behind).
    expect(computeHolders(snapshot({ ...base, idle: new Set(['ws-x']) }))[0]).toMatchObject({ state: 'free', why: 'no-agent' });
    expect(computeHolders(snapshot({ ...base, ptys: new Map([['ws-x', []]]) }))[0]).toMatchObject({ state: 'free', why: 'no-agent' });
  });
});

// ── The four caps over the same set ─────────────────────────────────────────

interface Rig {
  snap: Partial<HolderSnapshot>;
  guards: FanOutGuards;
  slots: AgentSlots;
  /** The launch record (factory/worker-slots.json in a temp dir). */
  launches: WorkerSlots;
  clock: { now: number };
  /** maxConcurrentAgents' workers, the factory cap, the bot's budget, the live cap. */
  four: () => { agents: number; factory: number; bot: number; live: number };
  /** A launch of `taskId` that came up in `workspaceId` (pane `sessionId`), `ago` ms before now. */
  launch: (taskId: string, workspaceId: string, sessionId: string, ago: number) => number;
  /** An app restart: the launch record read back from its file. */
  restart: () => void;
  /** The snapshot the host would assemble now. */
  build: () => HolderSnapshot;
}

function rig(over: Partial<HolderSnapshot> = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-holders-'));
  const guards = new FanOutGuards({ dir, now: () => NOW, openWorkspaceIds: () => [], ledgerTaskOwner: () => null, ledgerBotTask: () => null });
  setFanOutGuardsForTests(guards);
  const clock = { now: NOW };
  const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
  const open = (): WorkerSlots => {
    const s = new WorkerSlots(file, () => r.snap.rows ?? [], () => undefined, () => clock.now);
    s.load();
    setWorkerSlotsForTests(s);
    return s;
  };
  const r: Rig = {
    snap: over,
    guards,
    clock,
    launches: null as unknown as WorkerSlots,
    slots: new AgentSlots({
      cap: () => 1,
      runningBots: () => 0,
      liveWorkers: () => {
        const h = computeHolders(build());
        return holderCounts(h).agents;
      },
      stillHeld: () => true,
      pollMs: 60_000,
    }),
    four: () => {
      const o = openBotWorkers(BOT);
      return { agents: r.slots.inUse(), factory: o.factory, bot: o.bot, live: guards.liveTaskCount() };
    },
    launch: (taskId, workspaceId, sessionId, ago) => {
      clock.now = NOW - ago;
      const { gen } = r.launches.beginLaunch({ taskId, origin: 'bot', botId: BOT, ownerWorkspaceId: OWNER });
      r.launches.launched(taskId, gen, workspaceId, sessionId);
      r.launches.flushForTests();
      clock.now = NOW;
      return gen;
    },
    restart: () => {
      r.launches.flushForTests();
      r.launches = open();
    },
    build: () => build(),
  };
  r.launches = open();
  // What the lifecycle host assembles: the test's records, the guards'
  // stamps and bookings, the agent budget's grants, the launch record.
  function build(): HolderSnapshot {
    const base = snapshot(r.snap);
    const openIds = [...(base.workspaces ?? [])];
    const stamps = new Map(base.stamps);
    for (const [ws, l] of Object.entries(guards.lineageFor(openIds))) stamps.set(ws, { owner: l.owner, ...(l.origin ? { origin: l.origin } : {}) });
    const pending = r.slots.pendingSlots();
    return {
      ...base,
      stamps,
      reservations: guards.reservedTasks(),
      grants: pending.grants,
      heldWorkspaces: pending.held,
      taskOfWorkspace: (ws) => taskOfWorkspace(ws)?.taskId ?? null,
      taskOfPane: (pty) => taskOfPane(pty)?.taskId ?? null,
      launchAt: (t) => r.launches.liveLaunchAt(t),
      launchOf: (t) => r.launches.launchOf(t),
    };
  }
  setHolderSource(build);
  return r;
}

afterEach(() => {
  setHolderSource(null);
  setFanOutGuardsForTests(null);
  setWorkerSlotsForTests(null);
});

describe('the four caps agree on the paths that used to split them (#2393)', () => {
  it('cold restart, daemon down: a task seen gone before frees every cap, one running at shutdown holds every cap', () => {
    const r = rig({
      rows: [row('gone', { status: 'completed' }), row('ran', { status: 'completed' }), row('owner', { status: 'completed', bot: false })],
      read: 'down',
      gone: new Set(['gone', 'owner']),
    });
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('a crash before the ledger register: the stamped workspace of a bot worker holds every cap', () => {
    const r = rig({ workspaces: new Set(['ws-lost']), ptys: new Map([['ws-lost', ['p-lost']]]), stamps: new Map([['ws-lost', { owner: OWNER, origin: { kind: 'bot', botId: BOT } }]]) });
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // The reconciler's row (lineage origin, #2403) is the same holder.
    r.snap = { ...r.snap, rows: [row('lost', { taskWorkspaceId: 'ws-lost', dispatch: { origin: { kind: 'bot', botId: BOT }, reconciled: true } })], busy: new Set(['ws-lost']) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('pause, then a row edit: no cap charges the paused task again', () => {
    const paused = row('p', { status: 'review_requested' });
    const r = rig({ rows: [paused], records: [record('p', { ended: 'reported' })] });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    r.snap = { ...r.snap, rows: [{ ...paused, rev: paused.rev + 1, updatedAt: NOW, summary: 'edited' }] };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('ended bot workers: past the window with its workspace open it still holds; closed in the window with no fact it holds; a fact frees it', () => {
    const old = row('old', { status: 'completed', updatedAt: NOW - 3 * DAY });
    const closed = row('closed', { status: 'failed' });
    const r = rig({ rows: [old, closed], workspaces: new Set([old.taskWorkspaceId]) });
    expect(r.four()).toEqual({ agents: 2, factory: 2, bot: 2, live: 2 });
    r.snap = { ...r.snap, gone: new Set(['old', 'closed']) };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('WSL and PowerShell attribution: an unattributed running shell holds every cap, a recovered idle shell frees every cap', () => {
    const wsl = row('wsl');
    const recovered = row('rec');
    const r = rig({ rows: [wsl, recovered], busy: new Set([wsl.taskWorkspaceId]), idle: new Set([recovered.taskWorkspaceId]) });
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // Ended: a WSL worker's agent seen running in its own pane holds.
    r.snap = { ...r.snap, rows: [{ ...wsl, status: 'completed' }, recovered], agentSeen: new Set([wsl.taskWorkspaceId]), gone: new Set(['wsl']) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('a spawn is one holder from its booking to its row: never charged twice', async () => {
    const r = rig({ workspaces: new Set() });
    expect(r.guards.reserve('k', 1, { ownerWorkspaceId: OWNER, botId: BOT })).toEqual({ ok: true });
    r.guards.commitStart('k');
    // Booked: every cap but the agent budget, which it waits for.
    expect(r.four()).toEqual({ agents: 0, factory: 1, bot: 1, live: 1 });
    r.guards.bindTask('k', 't');
    // cap 1: its own booking does not keep it waiting.
    const grant = await r.slots.acquire({ taskId: 't', title: 't', botId: BOT, ownerWorkspaceId: OWNER });
    expect(grant.ok).toBe(true);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // Its launch is recorded, then its pane's create stamps the workspace and
    // records it as that launch's, in one step.
    const { gen } = r.launches.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: OWNER });
    r.snap = { ...r.snap, workspaces: new Set(['ws-t']), ptys: new Map([['ws-t', []]]) };
    const create = { fanoutTaskOf: OWNER, workspaceId: 'ws-t', fanoutOrigin: { kind: 'bot', botId: BOT }, fanoutLaunch: { taskId: 't', gen } };
    stampFanoutTaskPane(create, r.guards, () => r.launches);
    recordFanoutTaskPane(create, 'p-t', () => r.launches);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    r.launches.launched('t', gen, 'ws-t', 'p-t');
    // Registered: the row, then the grant released, then the spawn settled.
    r.snap = { ...r.snap, ptys: new Map([['ws-t', ['p-t']]]), rows: [row('t', { rev: 1, updatedAt: NOW })] };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    if (grant.ok) grant.release();
    r.guards.taskSettled('k', 't');
    r.guards.settleStarted('k');
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('a verify task with its verdict frees every cap; the owner\'s own fan-outs count only on the live cap', () => {
    const verify = row('v', { status: 'review_requested', dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'verify' } });
    const own = row('own', { bot: false });
    const r = rig({ rows: [verify, own], busy: new Set([verify.taskWorkspaceId, own.taskWorkspaceId]), verdicted: new Set(['v']) });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 1 });
  });

  it('a bot\'s resume holds through its granted slot, once', () => {
    const r = rig({ rows: [row('res', { status: 'completed' })], records: [record('res')] });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    const g = r.slots.tryAcquire({ taskId: 'res', botId: BOT });
    expect(g?.ok).toBe(true);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // The resume's own budget check leaves its task out and adds it once.
    const holders = computeHolders({ ...snapshot(r.snap), grants: r.slots.pendingSlots().grants });
    expect(holderCounts(holders.filter((h) => h.taskId !== 'res'), BOT).bot).toBe(0);
  });

  it('a fan-out dropped after it started booking leaves no booking behind', () => {
    const r = rig({ workspaces: new Set() });
    r.guards.reserve('k', 2, { ownerWorkspaceId: OWNER, botId: BOT });
    r.guards.commitStart('k');
    r.guards.release('k');
    r.guards.settleStarted('k');
    expect(r.guards.reservedTasks()).toEqual([]);
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('with the open workspaces unknown, the live cap refuses rather than count', () => {
    const r = rig({ workspaces: null });
    const res = r.guards.reserve('k', 1, { ownerWorkspaceId: OWNER });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/live-task count is unavailable/);
  });
});

// ── One regression per finding of the holder set's review rounds ───────────
// (R8.2 and R9 run through the real liveness reader:
// taskWorkspaceLiveness.test.ts, "sightings by task".)

describe('holder-set review rounds R1–R10 (#2393)', () => {
  it('R1.1: a row edit moves neither the ended window nor the launch grace', () => {
    // An ended bot task launched two days ago, its workspace closed: past the
    // window, and an edit of its row now does not reopen it.
    const done = row('done', { status: 'failed', updatedAt: NOW - 2 * DAY });
    const r = rig({ rows: [done], workspaces: new Set() });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    r.snap = { ...r.snap, rows: [{ ...done, rev: done.rev + 5, updatedAt: NOW, summary: 'edited' }] };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    // A worker launched 30s ago, its shell read idle before its agent: held
    // in its grace, whatever its row's revision or edit time says.
    r.launch('fresh', 'ws-fresh', 'p-fresh', 30_000);
    r.snap = { rows: [row('fresh', { rev: 9, updatedAt: NOW - 10 * DAY })], workspaces: new Set(['ws-fresh']), ptys: new Map([['ws-fresh', ['p-fresh']]]), idle: new Set(['ws-fresh']), readAt: NOW - 60_000 };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R1.2: with no holder set installed, a bot fan-out booked and not started still counts on the bot caps', () => {
    const r = rig();
    setHolderSource(null);
    r.guards.reserve('k', 2, { ownerWorkspaceId: OWNER, botId: BOT });
    expect(openBotWorkers(BOT)).toMatchObject({ bot: 2, factory: 2, botStarting: 2 });
  });

  it('R1.3: two resumes of one bot with a budget of one: the first to pass its check holds, the other is counted once', () => {
    const r = rig({ rows: [row('a', { status: 'completed' }), row('b', { status: 'completed' })], records: [record('a'), record('b')] });
    const snap = (grants: Array<{ taskId: string; botId: string }>) => computeHolders({ ...snapshot(r.snap), grants });
    // Both granted, neither past its budget check: each check sees no other.
    const both = snap([{ taskId: 'a', botId: BOT }, { taskId: 'b', botId: BOT }]);
    const others = (self: string) => holderCounts(both.filter((h) => h.taskId !== self && h.why !== 'resuming'), BOT).bot;
    expect(others('a')).toBe(0);
    // ...while every cap counts both.
    expect(holderCounts(both, BOT)).toMatchObject({ live: 2, workers: 2, agents: 2, bot: 2 });
  });

  it('R1.4: a respawned worker\'s new workspace is its task\'s from its pane\'s create on, before its session exists', () => {
    const r = rig({ rows: [row('t', { status: 'completed' })], records: [record('t')] });
    expect(r.slots.tryAcquire({ taskId: 't', botId: BOT })?.ok).toBe(true);
    const { gen } = r.launches.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: OWNER });
    // The renderer created the workspace; the mirror lists no pane of it yet.
    r.snap = { ...r.snap, workspaces: new Set(['ws-t', 'ws-new']), ptys: new Map([['ws-t', ['p-t']], ['ws-new', []]]) };
    const create = { fanoutTaskOf: OWNER, workspaceId: 'ws-new', fanoutOrigin: { kind: 'bot', botId: BOT }, fanoutLaunch: { taskId: 't', gen } };
    stampFanoutTaskPane(create, r.guards, () => r.launches);
    recordFanoutTaskPane(create, 'p-new', () => r.launches);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R2.1: a worker resumed into a new workspace: its old workspace, still open, is the same holder', () => {
    const r = rig();
    r.launch('t', 'ws-old', 'p-old', 3_600_000);
    r.launch('t', 'ws-new', 'p-new', 600_000);
    r.snap = {
      rows: [row('t', { status: 'completed', taskWorkspaceId: 'ws-new' })],
      records: [record('t', { state: 'resumed', taskWorkspaceId: 'ws-new' })],
      workspaces: new Set(['ws-old', 'ws-new']),
      ptys: new Map([['ws-old', ['p-shell']], ['ws-new', ['p-new']]]),
      stamps: new Map([['ws-old', { owner: OWNER }], ['ws-new', { owner: OWNER }]]),
    };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R2.2: an ended row stays past its window however many tasks end after it and however often it is edited', () => {
    const r = rig();
    r.launch('old', 'ws-old', 'p-old', 2 * DAY);
    for (let i = 0; i < 50; i++) r.launch(`later${i}`, `ws-later${i}`, `p-later${i}`, DAY - i);
    const old = row('old', { status: 'completed', updatedAt: NOW });
    r.snap = { rows: [old], workspaces: new Set(), gone: new Set() };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    r.restart();
    r.snap = { ...r.snap, rows: [{ ...old, rev: old.rev + 1, updatedAt: NOW }] };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('R2.1/R3 upgrade: a workspace of a worker resumed before launch records were kept is its task\'s by its reclaim record', () => {
    const r = rig({
      rows: [row('t', { status: 'completed', taskWorkspaceId: 'ws-new' })],
      records: [record('t', { state: 'resumed', taskWorkspaceId: 'ws-old', paneWorkspaceId: 'ws-new' })],
      workspaces: new Set(['ws-old', 'ws-new']),
      ptys: new Map([['ws-old', ['p-shell']], ['ws-new', ['p-new']]]),
      stamps: new Map([['ws-old', { owner: OWNER }], ['ws-new', { owner: OWNER }]]),
    });
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R3: after a restart, the workspaces of a worker resumed A → B → C are all its task\'s', () => {
    const r = rig();
    r.launch('t', 'ws-a', 'p-a', 3 * 3_600_000);
    r.launch('t', 'ws-b', 'p-b', 2 * 3_600_000);
    r.launch('t', 'ws-c', 'p-c', 3_600_000);
    r.restart();
    r.snap = {
      rows: [row('t', { status: 'completed', taskWorkspaceId: 'ws-c' })],
      records: [record('t', { state: 'resumed', taskWorkspaceId: 'ws-a', paneWorkspaceId: 'ws-c' })],
      workspaces: new Set(['ws-a', 'ws-b', 'ws-c']),
      ptys: new Map([['ws-a', []], ['ws-b', []], ['ws-c', ['p-c']]]),
      stamps: new Map([['ws-a', { owner: OWNER }], ['ws-b', { owner: OWNER, origin: { kind: 'bot', botId: BOT } }], ['ws-c', { owner: OWNER }]]),
    };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R4: a paused worker relaunched by hand holds every cap before any read sees it, and after it fails', () => {
    const r = rig({ rows: [row('p', { status: 'review_requested' })], records: [record('p', { ended: 'reported', at: NOW - 5 * 60_000 })], read: 'down' });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    // Relaunched in its pane after the stop (past the launch grace), then
    // reported again.
    r.launch('p', 'ws-p', 'p-p', 3 * 60_000);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // ...and if it then failed, the old stop still says nothing of it.
    r.snap = { ...r.snap, rows: [row('p', { status: 'failed' })] };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R5.1: a read that saw a paused worker idle says nothing of it once it was relaunched after that read', () => {
    const r = rig({ rows: [row('p', { status: 'review_requested' })], records: [record('p', { ended: 'reported', at: NOW - 10 * 60_000 })], idle: new Set(['ws-p']), readAt: NOW - 4 * 60_000 });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    r.launch('p', 'ws-p', 'p-p', 3 * 60_000);
    for (const read of ['ok', 'stale'] as const) {
      r.snap = { ...r.snap, read };
      expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    }
    // A read started after the launch that sees it idle frees it again.
    r.snap = { ...r.snap, read: 'ok', readAt: NOW - 10_000 };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('R5.2: an owner\'s Resume under way counts on the bot\'s own budget check; a bot\'s is booked apart', () => {
    const base = snapshot({ rows: [row('a', { status: 'completed' })], records: [record('a')] });
    expect(holderOf(computeHolders({ ...base, grants: [{ taskId: 'a', botId: BOT, byOwner: true }] }), 'a')?.why).toBe('starting');
    expect(holderOf(computeHolders({ ...base, grants: [{ taskId: 'a', botId: BOT }] }), 'a')?.why).toBe('resuming');
  });

  it('R6.1: an open task whose own agent is seen running elsewhere holds, its workspace idle', () => {
    const r = rig({ rows: [row('m')], idle: new Set(['ws-m']), agentSeen: new Set(['ws-m']) });
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R6.2: past its grace, a worker whose last good read predates its launch is not freed by that read', () => {
    const r = rig();
    r.launch('t', 'ws-t', 'p-t', 2 * SLOT_ROW_GRACE_MS);
    r.snap = { rows: [row('t')], idle: new Set(['ws-t']), read: 'stale', readAt: NOW - 3 * SLOT_ROW_GRACE_MS };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    r.snap = { ...r.snap, read: 'ok', readAt: NOW - 5_000 };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('R7.1: a worker with no row whose pane moved out of its workspace holds, by its launch record', () => {
    const r = rig();
    r.launch('x', 'ws-x', 'p-x', 3_600_000);
    r.snap = { workspaces: new Set(['ws-x', OWNER]), ptys: new Map([['ws-x', []], [OWNER, ['p-x']]]), stamps: new Map([['ws-x', { owner: OWNER, origin: { kind: 'bot', botId: BOT } }]]), agentTasks: new Map([['x', BOT]]) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R7.2: a failed task long ended, its workspace closed, its agent seen running, holds', () => {
    const r = rig();
    r.snap = { rows: [row('f', { status: 'failed', updatedAt: NOW - 3 * DAY })], workspaces: new Set(), agentTasks: new Map([['f', BOT]]) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R8.1: with no row and no workspace left, the sighting of its pane alone holds, as its bot\'s', () => {
    const r = rig();
    r.snap = { workspaces: new Set(), agentTasks: new Map([['y', BOT]]) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('R10: a worker whose register failed holds in its launch grace, and while no read since its launch saw it', () => {
    const r = rig();
    // The shell was read idle before the agent's launch line; the ledger
    // register then failed and the spawn kept the workspace.
    r.launch('h', 'ws-h', 'p-h', 30_000);
    r.snap = { workspaces: new Set(['ws-h']), ptys: new Map([['ws-h', ['p-h']]]), idle: new Set(['ws-h']), readAt: NOW - 60_000 };
    const g = r.slots.tryAcquire({ taskId: 'h', botId: BOT });
    if (g?.ok) g.hold('ws-h');
    expect(r.slots.pendingSlots().held).toEqual(['ws-h']);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // Past its grace, reads failing since: still counted.
    r.clock.now = NOW;
    r.snap = { ...r.snap, now: NOW + 2 * SLOT_ROW_GRACE_MS, read: 'stale' };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // A read after its launch that sees no agent frees it.
    r.snap = { ...r.snap, read: 'ok', readAt: NOW + SLOT_ROW_GRACE_MS };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });
});

describe('Codex rounds on the durable-identity holder set (#2393)', () => {
  it('C1.1: a task its launch record says the owner started stays the owner\'s when its row has no dispatch and its pane is sighted', () => {
    const r = rig();
    r.clock.now = NOW - 3_600_000;
    const { gen } = r.launches.beginLaunch({ taskId: 'o', origin: 'owner', ownerWorkspaceId: OWNER });
    r.launches.launched('o', gen, 'ws-o', 'p-o');
    r.clock.now = NOW;
    r.snap = { rows: [row('o', { dispatch: undefined })], busy: new Set(['ws-o']), agentTasks: new Map([['o', undefined]]) };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 1 });
  });

  it('C1.3: a workspace a respawn moved the worker out of, left open with no pane, does not keep an idle task held', () => {
    const r = rig();
    r.launch('t', 'ws-a', 'p-a', 3 * 3_600_000);
    r.launch('t', 'ws-b', 'p-b', 3_600_000);
    r.snap = {
      rows: [row('t', { taskWorkspaceId: 'ws-b' })],
      workspaces: new Set(['ws-a', 'ws-b']),
      ptys: new Map([['ws-a', []], ['ws-b', ['p-b']]]),
      stamps: new Map([['ws-a', { owner: OWNER }], ['ws-b', { owner: OWNER }]]),
      idle: new Set(['ws-b']),
    };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    // Its only workspace with no pane at all is not read idle: it holds.
    r.snap = { ...r.snap, idle: new Set() };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('C4.1: an adopted pane resumed in another task\'s workspace leaves that workspace the other task\'s: one holder', () => {
    const r = rig();
    r.launch('a', 'ws-w', 'p-a', 3 * 3_600_000);
    r.launch('b', 'ws-b', 'p-b', 2 * 3_600_000);
    // b's pane, moved into a's workspace, resumed where it is now.
    const { gen } = r.launches.beginLaunch({ taskId: 'b', origin: 'bot', botId: BOT, ownerWorkspaceId: OWNER, pane: { sessionId: 'p-b', workspaceId: 'ws-w' } });
    r.launches.launched('b', gen, 'ws-w', 'p-b');
    expect(r.launches.workspaceOf('ws-w')?.taskId).toBe('a');
    expect(r.launches.paneOf('p-b')?.taskId).toBe('b');
    // What the liveness reader then shows: b's sighting is its row's
    // workspace's, and a's workspace holds only b's (foreign) pane.
    r.snap = {
      rows: [row('a', { status: 'completed', taskWorkspaceId: 'ws-w' }), row('b', { taskWorkspaceId: 'ws-b' })],
      records: [record('a', { taskWorkspaceId: 'ws-w' })],
      workspaces: new Set(['ws-w', 'ws-b']),
      ptys: new Map([['ws-w', ['p-b']], ['ws-b', []]]),
      agentSeen: new Set(['ws-b']),
      agentTasks: new Map([['b', BOT]]),
      idle: new Set(['ws-w']),
    };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('C7.1: a running sighting from a read before a successful stop does not hold the stopped worker', () => {
    const r = rig({
      rows: [row('s', { status: 'completed' })],
      records: [record('s', { at: NOW - 60_000 })],
      agentSeen: new Set(['ws-s']),
      agentTasks: new Map([['s', BOT]]),
      busy: new Set(['ws-s']),
      read: 'stale',
      readAt: NOW - 120_000,
    });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    // A read after the stop that still sees it running holds it (#2339).
    r.snap = { ...r.snap, read: 'ok', readAt: NOW - 5_000 };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('GLM: a gone fact older than the worker\'s last launch frees nothing', () => {
    const r = rig();
    r.launch('g', 'ws-g', 'p-g', 30 * 60_000);
    r.snap = { rows: [row('g', { status: 'completed' })], gone: new Set(['g']), goneAt: () => NOW - 60 * 60_000 };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    // A fact written after that launch frees it.
    r.snap = { ...r.snap, goneAt: () => NOW - 10 * 60_000 };
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('GLM: one look answers every cap in the same turn while its key holds; the next turn looks again', async () => {
    let reads = 0;
    let key = 1;
    let snap = snapshot({ rows: [row('a')], busy: new Set(['ws-a']) });
    setHolderSource(() => {
      reads++;
      return snap;
    }, () => [key]);
    expect(liveHolders()?.holders).toHaveLength(1);
    expect(liveHolders()?.holders).toHaveLength(1);
    expect(reads).toBe(1);
    // A change moves the key: the next look is fresh, in the same turn too.
    snap = snapshot({ rows: [row('a'), row('b')], busy: new Set(['ws-a', 'ws-b']) });
    key = 2;
    expect(liveHolders()?.holders).toHaveLength(2);
    expect(reads).toBe(2);
    // The next turn looks again with the key unchanged (time-bound rules).
    await Promise.resolve();
    liveHolders();
    expect(reads).toBe(3);
    // A source with no key is never remembered.
    setHolderSource(() => {
      reads++;
      return snap;
    });
    liveHolders();
    liveHolders();
    expect(reads).toBe(5);
  });

  it('GLM: with looks remembered, a decision right after a booking, a grant or a stamp sees it', async () => {
    const r = rig({ workspaces: new Set() });
    // The host's key: the shared change counter (holderInputs.ts).
    const build = r.build;
    setHolderSource(build, () => [r.guards, holderInputsRevision()]);
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    expect(r.guards.reserve('k', 1, { ownerWorkspaceId: OWNER, botId: BOT })).toEqual({ ok: true });
    expect(r.four()).toEqual({ agents: 0, factory: 1, bot: 1, live: 1 });
    r.guards.commitStart('k');
    r.guards.bindTask('k', 't');
    const g = r.slots.tryAcquire({ taskId: 't', botId: BOT });
    expect(g?.ok).toBe(true);
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
    if (g?.ok) g.release();
    r.guards.taskSettled('k', 't');
    r.guards.settleStarted('k');
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });
});

describe('the earlier fixes hold through the set', () => {
  it('#2255: a cap reads the panes as they are at the check, not as the previous check saw them', () => {
    const rows = [row('a'), row('b'), row('c')];
    const r = rig({ rows, busy: new Set(rows.map((x) => x.taskWorkspaceId)) });
    expect(r.four().factory).toBe(3);
    r.snap = { ...r.snap, busy: new Set(['ws-a']), idle: new Set(['ws-b', 'ws-c']) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('#2314: after a restart, a reported worker the reclaim stopped holds no cap, with no read yet', () => {
    const r = rig({ rows: [row('rep', { status: 'review_requested' })], records: [record('rep', { ended: 'reported' })], read: 'down' });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
  });

  it('#2321: stopped workers, a respawned shell with no agent and ended rows hold no bot slot', () => {
    const r = rig({
      rows: [row('stopped', { status: 'review_requested' }), row('respawned'), row('ended', { status: 'completed' })],
      records: [record('stopped', { ended: 'reported' }), record('ended')],
      idle: new Set(['ws-respawned']),
    });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    // A worker relaunched in the stopped task's workspace holds again.
    r.snap = { ...r.snap, busy: new Set(['ws-stopped']) };
    expect(r.four()).toEqual({ agents: 1, factory: 1, bot: 1, live: 1 });
  });

  it('#2339: owner-stopped tasks seen gone free their slots; one left stopping holds; an agent seen running holds over a stopped record', () => {
    const r = rig({
      rows: [
        ...[0, 1, 2].map((i) => row(`os${i}`, { status: 'cancelled', summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system', workspaceId: 'daemon' } })),
        row('stuck', { status: 'completed' }),
        row('seen', { status: 'completed' }),
      ],
      gone: new Set(['os0', 'os1', 'os2']),
      records: [record('stuck', { state: 'stopping' }), record('seen')],
      agentSeen: new Set(['ws-seen']),
    });
    expect(r.four()).toEqual({ agents: 2, factory: 2, bot: 2, live: 2 });
  });

  it('#2387: a cold start with the daemon still restoring: ended tasks with facts count 0 of 8', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`e${i}`, { status: i % 2 ? 'completed' : 'failed', bot: i % 3 !== 0 }));
    const r = rig({ rows, read: 'down', gone: new Set(rows.map((x) => x.id)) });
    expect(r.four()).toEqual({ agents: 0, factory: 0, bot: 0, live: 0 });
    expect(r.guards.reserve('k', 8, { ownerWorkspaceId: OWNER })).toEqual({ ok: true });
  });
});
