// Fan-out runaway brakes — the lineage stamp, the two global caps and the
// audit log. Each store is pinned against a fresh instance over the SAME dir,
// because "survives a restart" is the property the caps exist for: a loop that
// restarts the app must not get a fresh hour.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FANOUT_AUDIT_FILENAME,
  FANOUT_CAP_WINDOW_MS,
  FANOUT_HOURLY_TASK_CAP,
  FANOUT_LINEAGE_FILENAME,
  FANOUT_LIVE_TASK_CAP,
  FanOutGuards,
  promptDigest,
  stampFanoutTaskPane,
  type FanOutAuditRecord,
} from '../fanoutGuards';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-guards-'));
}

function guards(dir: string, opts: { now?: () => number; live?: () => number; ledger?: (ws: string) => string | null } = {}) {
  return new FanOutGuards({
    dir,
    now: opts.now ?? (() => 1_000_000),
    countLiveTasks: opts.live ?? (() => 0),
    ledgerTaskOwner: opts.ledger ?? (() => null),
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
});

describe('review follow-ups', () => {
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
