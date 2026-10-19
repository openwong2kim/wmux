// Fan-out runaway brakes — the lineage stamp, the two global caps and the
// audit log. Each store is pinned against a fresh instance over the SAME dir,
// because "survives a restart" is the property the caps exist for: a loop that
// restarts the app must not get a fresh hour.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endedTaskAgentRuns, type WorkerSessionInfo } from '../../factory/workerReclaim';
import { setHolderSource, type HolderRecord, type HolderSnapshot } from '../../factory/workerHolders';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  FANOUT_AUDIT_FILENAME,
  FANOUT_CAP_WINDOW_MS,
  FANOUT_HOURLY_TASK_CAP,
  FANOUT_LINEAGE_FILENAME,
  FANOUT_LIVE_TASK_CAP,
  FanOutGuards,
  launchedAuditTask,
  liveCapMessage,
  promptDigest,
  setFanOutGuardsForTests,
  stampFanoutTaskPane,
  type FanOutAuditRecord,
} from '../fanoutGuards';

afterEach(() => {
  setHolderSource(null);
  setFanOutGuardsForTests(null);
});

/** What the worker lifecycle host installs: the holder set every live cap
 *  reads (factory/workerHolders.ts), over `g` (the hosted guards) and the
 *  records given; a good daemon read just now unless `over` says otherwise. */
function hostHolders(g: FanOutGuards, open: string[], over: Partial<HolderSnapshot> = {}): void {
  setFanOutGuardsForTests(g);
  setHolderSource(() => ({
    now: 1_000_000, rows: [], reclaimable: new Set(), catchupMs: 86_400_000,
    workspaces: new Set(open), ptys: new Map(open.map((ws) => [ws, [`p-${ws}`]])),
    stamps: new Map(Object.entries(g.lineageFor(open)).map(([ws, l]) => [ws, { owner: l.owner }])),
    read: 'ok', readAt: 999_000, idle: new Set(), busy: new Set(), agentSeen: new Set(), gone: new Set(),
    records: [], verdicted: new Set(), reservations: g.reservedTasks(), grants: [], heldWorkspaces: [],
    taskOfWorkspace: () => null, taskOfPane: () => null, launchAt: () => undefined, launchOf: () => null,
    ...over,
  }));
}

const ledgerRow = (id: string, ws: string, status: LedgerEntry['status']): LedgerEntry => ({
  schemaVersion: 1, id, taskWorkspaceId: ws, ownerWorkspaceId: 'ws-owner', title: id, status, rev: 1, updatedAt: 0,
  updatedBy: { kind: 'worker', workspaceId: ws }, dispatch: { origin: { kind: 'pane' } },
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-guards-'));
}

function guards(dir: string, opts: {
  now?: () => number;
  live?: () => number;
  ledger?: (ws: string) => string | null;
  ledgerBot?: (ws: string) => { owner: string; botId: string; at: number } | null;
} = {}) {
  return new FanOutGuards({
    dir,
    now: opts.now ?? (() => 1_000_000),
    countLiveTasks: opts.live ?? (() => 0),
    ledgerTaskOwner: opts.ledger ?? (() => null),
    ledgerBotTask: opts.ledgerBot ?? (() => null),
  });
}

describe('lineage stamp', () => {
  it('stamps a task workspace and reads it back after a restart', () => {
    const dir = tmpDir();
    guards(dir).markTask('ws-task', 'ws-owner');
    expect(guards(dir).fanoutOwnerOf('ws-task')).toBe('ws-owner');
    expect(guards(dir).fanoutOwnerOf('ws-other')).toBeNull();
  });

  it('falls back to the ledger, whatever the row status is', () => {
    // The ledger port answers regardless of status — a worker that set itself
    // `failed` is still a task workspace.
    const g = guards(tmpDir(), { ledger: (ws) => (ws === 'ws-failed-worker' ? 'ws-owner' : null) });
    expect(g.fanoutOwnerOf('ws-failed-worker')).toBe('ws-owner');
  });

  it('throws on an unreadable store instead of answering "not a task"', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, FANOUT_LINEAGE_FILENAME), '{ not json', 'utf8');
    expect(() => guards(dir).fanoutOwnerOf('ws-anything')).toThrow();
  });
});

describe('global caps', () => {
  it('stamps a dependent task on the hour when it starts, not when the fan-out is accepted', () => {
    const dir = tmpDir();
    let now = 10 * FANOUT_CAP_WINDOW_MS;
    const g = guards(dir, { now: () => now });
    expect(g.reserve('dep', 3)).toEqual({ ok: true });
    g.commitStart('dep', 2); // one first-wave task, two waiting
    // The live slots are all held while the two wait.
    expect(g.reserve('other', FANOUT_LIVE_TASK_CAP - 2).ok).toBe(false);
    // Fill the hour with other starts; the waiting tasks were not charged yet.
    for (let k = 0; k < FANOUT_HOURLY_TASK_CAP; k++) {
      if (!g.reserve(`f${k}`, 1).ok) break;
      g.commitStart(`f${k}`);
      g.settleStarted(`f${k}`);
    }
    expect(g.stampDeferredStart('dep').ok).toBe(false);
    // An hour later the window has room again, and the start is charged then.
    now += FANOUT_CAP_WINDOW_MS + 1;
    expect(g.stampDeferredStart('dep')).toEqual({ ok: true });
  });

  it(`refuses past ${FANOUT_LIVE_TASK_CAP} live tasks, counting ledger rows and in-flight reservations`, () => {
    const g = guards(tmpDir(), { live: () => 5 });
    expect(g.reserve('a', 3)).toEqual({ ok: true });
    g.commitStart('a');
    const over = g.reserve('b', 1);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.message).toMatch(new RegExp(`at most ${FANOUT_LIVE_TASK_CAP} fan-out tasks may be live`));
    // A fan-out that finished spawning stops holding its live slots.
    g.settleStarted('a');
    expect(g.reserve('b', 1)).toEqual({ ok: true });
  });

  it(`refuses past ${FANOUT_HOURLY_TASK_CAP} starts per rolling hour, names when room frees, and survives a restart`, () => {
    const dir = tmpDir();
    let now = 10 * FANOUT_CAP_WINDOW_MS;
    const clock = () => now;
    const first = guards(dir, { now: clock });
    for (let k = 0; k < FANOUT_HOURLY_TASK_CAP / 8; k++) {
      expect(first.reserve(`k${k}`, 8)).toEqual({ ok: true });
      first.commitStart(`k${k}`);
      first.settleStarted(`k${k}`);
      now += 60_000;
    }
    // A new process over the same dir still sees the full hour.
    const restarted = guards(dir, { now: clock });
    const over = restarted.reserve('late', 1);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.message).toMatch(/per rolling hour/);
    expect(!over.ok && over.message).toMatch(/Room frees at \d\d:\d\d UTC/);
    // Once the oldest stamp ages out of the window, there is room again.
    now = 10 * FANOUT_CAP_WINDOW_MS + FANOUT_CAP_WINDOW_MS + 1;
    expect(restarted.reserve('late', 1)).toEqual({ ok: true });
  });

  it('fills the hour with started fan-outs, and frees a reservation that never started', () => {
    const dir = tmpDir();
    const g = guards(dir);
    for (let k = 0; k < FANOUT_HOURLY_TASK_CAP / 8; k++) {
      expect(g.reserve(`p${k}`, 8)).toEqual({ ok: true });
      // Started and finished spawning, so only the hour still binds.
      g.commitStart(`p${k}`);
      g.settleStarted(`p${k}`);
    }
    expect(g.reserve('one-more', 1).ok).toBe(false);

    const fresh = guards(tmpDir());
    for (let k = 0; k < FANOUT_HOURLY_TASK_CAP / 8; k++) expect(fresh.reserve(`d${k}`, 8).ok).toBe(k === 0);
    fresh.release('d0');
    expect(fresh.reserve('after-release', 8)).toEqual({ ok: true });
  });
});

describe('audit log', () => {
  it('appends records and reads the newest first', () => {
    const dir = tmpDir();
    const g = guards(dir);
    const base: FanOutAuditRecord = {
      at: 1,
      idempotencyKey: 'k1',
      ownerWorkspaceId: 'ws-owner',
      callerIdentity: 'commander',
      repoPath: '/repo',
      titles: ['t'],
      roles: [''],
      roleCommands: [],
      promptSha256: [promptDigest('p')],
      approvedBy: 'auto',
      workerPermissionMode: 'auto',
    };
    g.appendAudit(base);
    g.appendAudit({ ...base, at: 2, idempotencyKey: 'k2', approvedBy: 'human' });
    const recent = guards(dir).recentAudit(10);
    expect(recent.map((r) => r.idempotencyKey)).toEqual(['k2', 'k1']);
    expect(fs.readFileSync(path.join(dir, FANOUT_AUDIT_FILENAME), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(recent[1].promptSha256[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a 'launched' entry for a task that got no workspace is not started and records no command", () => {
    expect(launchedAuditTask({ title: 'a', workspaceId: 'ws-a', initialCommand: 'claude "a"' })).toEqual({
      title: 'a',
      workspaceId: 'ws-a',
      command: 'claude "a"',
    });
    // A pane that came up but whose agent did not keeps its workspace and line.
    expect(launchedAuditTask({ title: 'a', workspaceId: 'ws-a', initialCommand: 'claude "a"', error: 'agent did not start' })).toEqual({
      title: 'a',
      workspaceId: 'ws-a',
      command: 'claude "a"',
      error: 'agent did not start',
    });
    expect(launchedAuditTask({ title: 'b', initialCommand: 'claude "b"', error: 'PTY create failed' })).toEqual({
      title: 'b',
      started: false,
      error: 'PTY create failed',
    });
    expect(launchedAuditTask({ title: 'c' })).toEqual({ title: 'c', started: false });
  });
});

describe('review follow-ups', () => {
  it('a dormant task workspace (worker reclaimed, kept open for Resume) holds no live slot', () => {
    const dir = tmpDir();
    const open = ['ws-a', 'ws-b', 'ws-c'];
    const g = new FanOutGuards({ dir, now: () => 1_000_000, openWorkspaceIds: () => open, ledgerTaskOwner: () => null });
    for (const ws of open) g.markTask(ws, 'ws-owner');
    const rows = open.map((ws) => ledgerRow(`t-${ws}`, ws, 'completed'));
    const stopped = (taskId: string, ws: string): HolderRecord => ({ taskId, botId: 'bot-0000000a', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: ws, title: taskId, state: 'stopped', ended: 'completed', at: 500_000 });
    hostHolders(g, open, { rows, records: [stopped('t-ws-a', 'ws-a'), stopped('t-ws-b', 'ws-b')] });
    expect(g.liveTaskCount()).toBe(1);
    // A snapshot that cannot be read refuses the live cap (fail closed).
    setHolderSource(() => {
      throw new Error('store unreadable');
    });
    expect(() => g.liveTaskCount()).toThrow();
    expect(g.reserve('k', 1).ok).toBe(false);
    // With no holder set installed, every open task workspace counts.
    setHolderSource(null);
    expect(g.liveTaskCount()).toBe(3);
  });

  it('counts live tasks by stamped workspaces that are still open, not by ledger status', () => {
    const dir = tmpDir();
    let open: string[] | null = ['ws-a', 'ws-b', 'ws-plain'];
    const g = new FanOutGuards({ dir, now: () => 1_000_000, openWorkspaceIds: () => open, ledgerTaskOwner: () => null });
    g.markTask('ws-a', 'ws-owner');
    g.markTask('ws-b', 'ws-owner');
    g.markTask('ws-closed', 'ws-owner');
    expect(g.liveTaskCount()).toBe(2);
    open = ['ws-plain'];
    expect(g.liveTaskCount()).toBe(0);
    // Unknown open set (renderer not up) refuses rather than guessing zero.
    open = null;
    const r = g.reserve('k', 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/live-task count is unavailable/);
  });

  it('stops counting a task as spawning once it settles, so a spawn is not counted twice', () => {
    let live = 0;
    const g = guards(tmpDir(), { live: () => live });
    expect(g.reserve('big', 4)).toEqual({ ok: true });
    g.commitStart('big');
    // Two tasks spawned: their open workspaces now count them.
    live = 2;
    g.taskSettled('big');
    g.taskSettled('big');
    // 2 live + 2 still spawning = 4, so 4 more fit exactly.
    expect(g.reserve('other', 4)).toEqual({ ok: true });
  });

  it('never shrinks the hour: a key reused after a restart adds to it', () => {
    const dir = tmpDir();
    const first = guards(dir);
    expect(first.reserve('same', 8)).toEqual({ ok: true });
    first.commitStart('same');
    first.settleStarted('same');
    const restarted = guards(dir);
    expect(restarted.reserve('same', 1)).toEqual({ ok: true });
    restarted.commitStart('same');
    restarted.settleStarted('same');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'fanout-caps.json'), 'utf8')) as { starts: { count: number }[] };
    expect(raw.starts.reduce((n, s) => n + s.count, 0)).toBe(9);
  });

  it('treats a torn caps file as a full hour from its mtime, and keeps the file', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'fanout-caps.json'), '{ torn', 'utf8');
    const g = new FanOutGuards({ dir, countLiveTasks: () => 0, ledgerTaskOwner: () => null });
    const r = g.reserve('k', 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/per rolling hour/);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('fanout-caps.json.corrupt-'))).toBe(true);
  });

  it('names the pending fan-outs, not a clock, when they are what fills the hour', () => {
    const g = guards(tmpDir());
    for (let k = 0; k < 3; k++) {
      expect(g.reserve(`p${k}`, 8)).toEqual({ ok: true });
      g.commitStart(`p${k}`);
      g.settleStarted(`p${k}`);
    }
    // All 24 are recorded, so a reservation cannot fit until the oldest ages out.
    const r = g.reserve('x', 1);
    expect(!r.ok && r.message).toMatch(/Room frees at/);

    const pendingOnly = guards(tmpDir(), { live: () => -100 });
    for (let k = 0; k < 3; k++) expect(pendingOnly.reserve(`q${k}`, 8)).toEqual({ ok: true });
    const r2 = pendingOnly.reserve('y', 1);
    expect(!r2.ok && r2.message).toMatch(/waiting to start/);
  });

  it('moves a torn lineage store aside: fan-out stays refused with a recovery hint, stamping keeps working', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, FANOUT_LINEAGE_FILENAME), 'garbage', 'utf8');
    const g = guards(dir);
    expect(() => g.fanoutOwnerOf('ws-x')).toThrow(/Delete that file once no fan-out task is still running/);
    // A human GUI fan-out still stamps its tasks.
    g.markTask('ws-new-task', 'ws-owner');
    const moved = fs.readdirSync(dir).find((n) => n.startsWith(`${FANOUT_LINEAGE_FILENAME}.corrupt-`));
    expect(moved).toBeTruthy();
    fs.unlinkSync(path.join(dir, moved!));
    expect(guards(dir).fanoutOwnerOf('ws-new-task')).toBe('ws-owner');
  });
});

describe('stampFanoutTaskPane (the pty.create half)', () => {
  it('stamps a task pane before it is created, ignores ordinary panes, and fails the create when it cannot stamp', () => {
    const g = guards(tmpDir());
    stampFanoutTaskPane({ workspaceId: 'ws-plain' }, g);
    expect(g.fanoutOwnerOf('ws-plain')).toBeNull();
    stampFanoutTaskPane({ workspaceId: 'ws-task', fanoutTaskOf: 'ws-owner' }, g);
    expect(g.fanoutOwnerOf('ws-task')).toBe('ws-owner');
    expect(() => stampFanoutTaskPane({ fanoutTaskOf: 'ws-owner' }, g)).toThrow(/needs its workspaceId/);
    const broken = { markTask: () => { throw new Error('disk full'); } };
    expect(() => stampFanoutTaskPane({ workspaceId: 'ws-x', fanoutTaskOf: 'ws-owner' }, broken)).toThrow(/disk full/);
  });
});

describe('requester origin on the lineage stamp', () => {
  it('records pane, orchestrator and gui origins and reads them back after a restart', () => {
    const dir = tmpDir();
    const g = guards(dir);
    stampFanoutTaskPane({
      workspaceId: 'ws-a',
      fanoutTaskOf: 'ws-owner',
      fanoutOrigin: { kind: 'pane', paneId: 'pane-74', surfaceId: 'surf-1', label: 'Compare · w115-74', ptyId: 'pty-9' },
    }, g);
    stampFanoutTaskPane({ workspaceId: 'ws-b', fanoutTaskOf: 'ws-owner', fanoutOrigin: { kind: 'orchestrator' } }, g);
    g.markTask('ws-c', 'ws-owner', { kind: 'gui' });
    const read = guards(dir).lineageFor(['ws-a', 'ws-b', 'ws-c']);
    // Stable ids only: a ptyId handed over with the origin is not persisted.
    expect(read['ws-a'].origin).toEqual({ kind: 'pane', paneId: 'pane-74', surfaceId: 'surf-1', label: 'Compare · w115-74' });
    expect(read['ws-b'].origin).toEqual({ kind: 'orchestrator' });
    expect(read['ws-c'].origin).toEqual({ kind: 'gui' });
    expect(read['ws-a'].owner).toBe('ws-owner');
  });

  it('loads a legacy store without origins, and drops only a malformed origin', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, FANOUT_LINEAGE_FILENAME), JSON.stringify({
      version: 1,
      tasks: {
        'ws-old': { owner: 'ws-owner', at: 5 },
        'ws-bad': { owner: 'ws-owner', at: 6, origin: { kind: 'someone-else', paneId: 'p' } },
        // A pane origin with no ids can never name its pane: dropped.
        'ws-idless': { owner: 'ws-owner', at: 7, origin: { kind: 'pane', label: 'w1-1' } },
      },
    }), 'utf8');
    const g = guards(dir);
    expect(g.fanoutOwnerOf('ws-old')).toBe('ws-owner');
    expect(g.lineageFor(['ws-old', 'ws-bad', 'ws-idless'])).toEqual({
      'ws-old': { owner: 'ws-owner', at: 5 },
      'ws-bad': { owner: 'ws-owner', at: 6 },
      'ws-idless': { owner: 'ws-owner', at: 7 },
    });
  });

  it('keeps the old reader shape: a stamp written with an origin still has owner and at', () => {
    const dir = tmpDir();
    guards(dir).markTask('ws-a', 'ws-owner', { kind: 'pane', paneId: 'p1', label: 'w1-2' });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FANOUT_LINEAGE_FILENAME), 'utf8')) as {
      version: number; tasks: Record<string, { owner: string; at: number }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.tasks['ws-a'].owner).toBe('ws-owner');
    expect(typeof raw.tasks['ws-a'].at).toBe('number');
  });

  it('a re-mark by the same owner never erases the origin, and can add a missing one', () => {
    const dir = tmpDir();
    let clock = 100;
    const g = guards(dir, { now: () => clock });
    g.markTask('ws-a', 'ws-owner', { kind: 'pane', paneId: 'p1', surfaceId: 's1', label: 'w1-2' });
    clock = 200;
    // FanOutService's idempotent second write carries no pane origin.
    g.markTask('ws-a', 'ws-owner');
    g.markTask('ws-a', 'ws-owner', { kind: 'gui' });
    expect(guards(dir).lineageFor(['ws-a'])['ws-a']).toEqual({
      owner: 'ws-owner', at: 100, origin: { kind: 'pane', paneId: 'p1', surfaceId: 's1', label: 'w1-2' },
    });
    g.markTask('ws-b', 'ws-owner');
    g.markTask('ws-b', 'ws-owner', { kind: 'orchestrator' });
    expect(guards(dir).lineageFor(['ws-b'])['ws-b']).toEqual({ owner: 'ws-owner', at: 200, origin: { kind: 'orchestrator' } });
  });
});

describe('a bot worker is named even without its stamp (ledger dispatch fallback)', () => {
  const BOT = 'bot-1a2b3c4d';
  const ledgerBot = (ws: string) => (ws === 'ws-w' ? { owner: 'ws-owner', botId: BOT, at: 42 } : null);

  it('a bot stamp answers with botId beside the origin', () => {
    const dir = tmpDir();
    guards(dir).markTask('ws-w', 'ws-owner', { kind: 'bot', botId: BOT });
    expect(guards(dir).lineageFor(['ws-w'])['ws-w']).toEqual({ owner: 'ws-owner', at: 1_000_000, origin: { kind: 'bot', botId: BOT }, botId: BOT });
  });

  it('no stamp at all (store set aside): the ledger row names the bot', () => {
    const dir = tmpDir();
    expect(guards(dir, { ledgerBot }).lineageFor(['ws-w', 'ws-plain'])).toEqual({
      'ws-w': { owner: 'ws-owner', at: 42, origin: { kind: 'bot', botId: BOT }, botId: BOT },
    });
  });

  it('a stamp without an origin gets the bot origin from the ledger; another owner\'s row never relabels it', () => {
    const dir = tmpDir();
    const g = guards(dir, { ledgerBot });
    g.markTask('ws-w', 'ws-owner');
    g.markTask('ws-x', 'ws-other');
    const read = guards(dir, { ledgerBot: (ws) => (ws === 'ws-x' ? { owner: 'ws-owner', botId: BOT, at: 1 } : ledgerBot(ws)) }).lineageFor(['ws-w', 'ws-x']);
    expect(read['ws-w']).toEqual({ owner: 'ws-owner', at: 1_000_000, origin: { kind: 'bot', botId: BOT }, botId: BOT });
    expect(read['ws-x']).toEqual({ owner: 'ws-other', at: 1_000_000 });
  });

  it('a stamp that has an origin wins over the ledger; a throwing ledger read is skipped', () => {
    const dir = tmpDir();
    guards(dir).markTask('ws-w', 'ws-owner', { kind: 'gui' });
    expect(guards(dir, { ledgerBot }).lineageFor(['ws-w'])['ws-w']).toEqual({ owner: 'ws-owner', at: 1_000_000, origin: { kind: 'gui' } });
    expect(guards(dir, { ledgerBot: () => { throw new Error('ledger down'); } }).lineageFor(['ws-z'])).toEqual({});
  });

  it('an unreadable store still answers bot workers from the ledger', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, FANOUT_LINEAGE_FILENAME), '{torn', 'utf8');
    expect(guards(dir, { ledgerBot }).lineageFor(['ws-w'])['ws-w']?.botId).toBe(BOT);
  });
});

describe('FanOutGuards.refundStart', () => {
  it('gives back the hour for tasks that never got a workspace, on disk too', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guards-refund-'));
    const g = new FanOutGuards({ dir: d, countLiveTasks: () => 0, ledgerTaskOwner: () => null });
    expect(g.reserve('k', 3).ok).toBe(true);
    g.commitStart('k');
    g.refundStart('k', 2);
    const caps = () => JSON.parse(fs.readFileSync(path.join(d, 'fanout-caps.json'), 'utf8')).starts as { id: string; count: number }[];
    expect(caps()).toEqual([expect.objectContaining({ id: 'k', count: 1 })]);
    g.refundStart('k', 5);
    expect(caps()).toEqual([]);
    // A fresh store (restart) sees the refund.
    const again = new FanOutGuards({ dir: d, countLiveTasks: () => 0, ledgerTaskOwner: () => null });
    expect(again.reserve('k2', 8).ok).toBe(true);
  });
});

describe('ended tasks hold no live slot (F25)', () => {
  type Row = { id: string; title: string; status: string; ptys: string[] };
  const ended = (status: string) => status === 'completed' || status === 'cancelled' || status === 'failed';
  /** What a read records (taskWorkspaceLiveness.ts): the ended tasks whose
   *  workspace runs no agent (the daemon's sessions, the task's own panes). */
  function goneOf(rows: Map<string, Row>, sessions: WorkerSessionInfo[], own: (id: string) => { taskId?: string } | null): Set<string> {
    const byId = new Map(sessions.map((x) => [x.id, x]));
    const out = new Set<string>();
    for (const r of rows.values()) if (ended(r.status) && !endedTaskAgentRuns(r.ptys, r.id, [], byId, own)) out.add(r.id);
    return out;
  }

  it('6 owner-stopped kept workspaces, one left stopping with no session, and 1 running: 1 live, and a fan-out is allowed', () => {
    const rows = new Map<string, Row>();
    // The owner's stop destroyed their sessions; the folders were kept.
    for (let i = 0; i < 6; i++) rows.set(`ws-stopped-${i}`, { id: `t-stopped-${i}`, title: `stopped ${i}`, status: 'cancelled', ptys: [`p-stopped-${i}`] });
    // A reclaim record stuck `stopping` for a task that ended; its pane is a shell at its prompt.
    rows.set('ws-stuck', { id: 't-stuck', title: 'stuck', status: 'completed', ptys: ['p-stuck'] });
    rows.set('ws-run', { id: 't-run', title: 'running', status: 'working', ptys: ['p-run'] });
    const sessions: WorkerSessionInfo[] = [
      { id: 'p-stuck', agentProcessAlive: undefined, commandRunning: false },
      { id: 'p-run', agentProcessAlive: true },
    ];
    const g = new FanOutGuards({ dir: tmpDir(), now: () => 1_000_000, openWorkspaceIds: () => [...rows.keys()], ledgerTaskOwner: () => null, ledgerBotTask: () => null });
    for (const ws of rows.keys()) g.markTask(ws, 'ws-owner');
    const open = [...rows.keys()];
    const ledger = [...rows].map(([ws, r]) => ledgerRow(r.id, ws, r.status as LedgerEntry['status']));
    const ptys = new Map([...rows].map(([ws, r]) => [ws, r.ptys]));
    // No read has seen the ended tasks' agents gone yet: every one may run.
    hostHolders(g, open, { rows: ledger, ptys, busy: new Set(['ws-run']) });
    expect(g.reserve('before', 1).ok).toBe(false);
    // A read saw them gone (agentGoneFacts.ts records it).
    hostHolders(g, open, { rows: ledger, ptys, busy: new Set(['ws-run']), gone: goneOf(rows, sessions, () => null) });
    expect(g.liveTaskCount()).toBe(1);
    expect(g.reserve('after', 1)).toEqual({ ok: true });
  });

  it('a task that ended with its agent still running holds its slot', () => {
    const rows = new Map<string, Row>([['ws-done', { id: 't-done', title: 'done', status: 'completed', ptys: ['p-done'] }]]);
    const g = new FanOutGuards({ dir: tmpDir(), now: () => 1_000_000, openWorkspaceIds: () => ['ws-done'], ledgerTaskOwner: () => null });
    g.markTask('ws-done', 'ws-owner');
    const base = { rows: [ledgerRow('t-done', 'ws-done', 'completed')], ptys: new Map([['ws-done', ['p-done']]]) };
    hostHolders(g, ['ws-done'], { ...base, gone: goneOf(rows, [{ id: 'p-done', agentProcessAlive: true }], () => null) });
    expect(g.liveTaskCount()).toBe(1);
    // A WSL worker's launch line in its own pane, too.
    const wsl: WorkerSessionInfo = { id: 'p-done', commandRunning: true, wslTarget: { distribution: 'Ubuntu' } };
    hostHolders(g, ['ws-done'], { ...base, gone: goneOf(rows, [wsl], (id) => (id === 'p-done' ? { taskId: 't-done' } : null)) });
    expect(g.liveTaskCount()).toBe(1);
  });

  it('the live-cap refusal names what holds the slots and how one frees', () => {
    const tasks: Record<string, { title: string; status: string }> = {
      'ws-1': { title: 'fix login', status: 'working' },
      'ws-2': { title: 'perf A', status: 'review_requested' },
      'ws-3': { title: 'docs', status: 'completed' },
    };
    const open = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6', 'ws-7', 'ws-8'];
    const g = new FanOutGuards({ dir: tmpDir(), now: () => 1_000_000, openWorkspaceIds: () => open, ledgerTaskOwner: () => null, ledgerTaskOf: (ws) => tasks[ws] ?? null });
    for (const ws of open) g.markTask(ws, 'ws-owner');
    const r = g.reserve('k', 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toBe(
      'fan-out refused: at most 8 fan-out tasks may be live at once across wmux (8 live now, 1 requested). ' +
        'Held by: 2 open ("fix login", "perf A"); 1 ended whose agent is not known to have stopped ("docs"); 5 task workspaces with no task record. ' +
        'A slot frees when a task ends and its agent stops, or when its task workspace is closed.',
    );
    expect(liveCapMessage(8, 2, { open: ['a', 'b', 'c', 'd', 'e'], ended: [], untracked: 0, starting: 3 })).toBe(
      'fan-out refused: at most 8 fan-out tasks may be live at once across wmux (8 live now, 2 requested). ' +
        'Held by: 5 open ("a", "b", "c" and 2 more); 3 starting. A slot frees when a task ends and its agent stops, or when its task workspace is closed.',
    );
    expect(liveCapMessage(7, 2, null)).toBe(
      'fan-out refused: at most 8 fan-out tasks may be live at once across wmux (7 live now, 2 requested). A slot frees when a task ends and its agent stops, or when its task workspace is closed.',
    );
  });
});
