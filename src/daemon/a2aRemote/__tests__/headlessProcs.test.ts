// The worktree check that holds an ended headless start whose agent's process
// tree could not be checked whole: a process working in the worktree (an
// orphaned child of the agent, say) keeps the hold; none releases it; no
// readable /proc means it cannot be told and the hold stays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processesWorkingIn } from '../headlessProcs';

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

describe('processes working in a worktree', () => {
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
