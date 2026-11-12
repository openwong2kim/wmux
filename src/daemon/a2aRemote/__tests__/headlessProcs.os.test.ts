// The worktree check that holds an ended headless start whose agent's process
// tree could not be checked whole: a process working in the worktree (an
// orphaned child of the agent, say) keeps the hold; none releases it; no
// readable /proc means it cannot be told and the hold stays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PosixProcRow } from '../../automation/verifiedTreeKill';
import type { HeadlessSurvivor } from '../headlessStartStore';
import { processesWorkingIn, snapshotTree, stillHeld, type HeadlessProcDeps } from '../headlessProcs';

let dir: string;
let proc: string;
let worktree: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'headless-procs-')));
  proc = path.join(dir, 'proc');
  worktree = path.join(dir, 'worktrees', 'remote-x');
  fs.mkdirSync(path.join(worktree, 'apps'), { recursive: true });
  fs.mkdirSync(proc);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fake /proc/<pid>/cwd. */
const pidIn = (pid: number, cwd: string): void => {
  fs.mkdirSync(path.join(proc, String(pid)));
  fs.symlinkSync(cwd, path.join(proc, String(pid), 'cwd'));
};

// Headless starts run on POSIX hosts; the fake /proc uses symlinks Windows runners cannot always make.
describe.skipIf(process.platform === 'win32')('processes working in a worktree', () => {
  it('a process (an orphaned child, say) whose folder is in the worktree, or below it, is found', async () => {
    pidIn(101, dir);
    pidIn(102, path.join(worktree, 'apps'));
    expect(await processesWorkingIn(worktree, proc)).toBe(true);
  });

  it('none: nothing works there (a sibling folder with the same prefix does not count)', async () => {
    fs.mkdirSync(`${worktree}-other`);
    pidIn(101, dir);
    pidIn(103, `${worktree}-other`);
    fs.mkdirSync(path.join(proc, 'self'));
    expect(await processesWorkingIn(worktree, proc)).toBe(false);
  });

  it('no /proc to read: cannot be told', async () => {
    expect(await processesWorkingIn(worktree, path.join(dir, 'no-proc'))).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('the hold on a start whose agent tree was not confirmed gone', () => {
  const START = 'Thu Nov 12 10:00:00 2026';
  const row = (pid: number, ppid: number, start = START, stat = 'S'): PosixProcRow => ({ pid, ppid, stat, start });
  const deps = (rows: PosixProcRow[] | 'unreadable'): HeadlessProcDeps => ({
    listProcesses: async () => {
      if (rows === 'unreadable') throw new Error('ps failed');
      return rows;
    },
    procRoot: proc,
  });
  const tracked = (pid: number, start = START): HeadlessSurvivor => ({ pid, startTime: start, reason: 'in the tree' });

  it('the snapshot taken before the kill is the tree under the session, each with its start time', async () => {
    const snap = await snapshotTree(10, deps([row(1, 0), row(10, 1), row(11, 10), row(12, 11), row(20, 1), row(13, 10, START, 'Z')]));
    expect(snap?.map((s) => s.pid).sort()).toEqual([10, 11, 12]);
    expect(snap?.every((s) => s.startTime === START)).toBe(true);
    expect(await snapshotTree(10, deps('unreadable'))).toBeNull();
  });

  it('a tracked process that changed folder out of the worktree still holds it', async () => {
    pidIn(11, dir);
    expect(await stillHeld([tracked(11)], worktree, deps([row(11, 1)]))).toHaveLength(1);
  });

  it('an unreadable process table, or a tracked row whose start cannot be read, keeps the hold', async () => {
    expect(await stillHeld([tracked(11)], worktree, deps('unreadable'))).toHaveLength(1);
    expect(await stillHeld([tracked(11)], worktree, deps([row(11, 1, '')]))).toHaveLength(1);
  });

  it('a pid now used by another process (another start time) releases it once nothing works in the worktree', async () => {
    pidIn(11, dir);
    expect(await stillHeld([tracked(11)], worktree, deps([row(11, 1, 'Fri Nov 13 09:00:00 2026')]))).toEqual([]);
  });

  it('every tracked process gone but one working in the worktree (never in the tree) keeps the hold', async () => {
    pidIn(30, path.join(worktree, 'apps'));
    expect(await stillHeld([tracked(11)], worktree, deps([row(30, 1)]))).toHaveLength(1);
  });

  it('no snapshot (unverified) keeps the hold', async () => {
    expect(await stillHeld([{ pid: 10, reason: 'tree unknown', unverified: true }], worktree, deps([]))).toHaveLength(1);
  });

  it('without /proc (macOS) the whole snapshot being gone releases it, so it is not held for good', async () => {
    const noProc = { ...deps([]), procRoot: path.join(dir, 'no-proc') };
    expect(await stillHeld([tracked(11)], worktree, noProc)).toEqual([]);
    expect(await stillHeld([tracked(11)], worktree, { ...noProc, listProcesses: async () => [row(11, 1)] })).toHaveLength(1);
  });
});
