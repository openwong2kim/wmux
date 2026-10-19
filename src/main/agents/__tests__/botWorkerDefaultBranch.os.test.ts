// A bot repository's default branch: GitHub's own, else origin/HEAD, read
// once per repository per TTL and recorded for the workers' push rules.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BRANCH_TTL_MS, defaultBranchRefusal, noteBotRepoDefaultBranch, readRepoDefaultBranch, resetDefaultBranchReadsForTests } from '../botWorkerDefaultBranch';
import { readBotWorkerDefaultBranches } from '../../../shared/botWorkerGuard';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-default-'));
  resetDefaultBranchReadsForTests();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function runner(gh: string | Error, git: string | Error) {
  return vi.fn(async (cmd: 'gh' | 'git') => {
    const out = cmd === 'gh' ? gh : git;
    if (out instanceof Error) throw out;
    return out;
  });
}

describe('readRepoDefaultBranch', () => {
  it('GitHub\'s default branch first, then origin/HEAD, else null', async () => {
    expect(await readRepoDefaultBranch('/r', { run: runner('develop\n', 'refs/remotes/origin/main\n') })).toBe('develop');
    expect(await readRepoDefaultBranch('/r', { run: runner(new Error('offline'), 'refs/remotes/origin/trunk\n') })).toBe('trunk');
    expect(await readRepoDefaultBranch('/r', { run: runner('', 'refs/remotes/origin/x y') })).toBe('x y');
    expect(await readRepoDefaultBranch('/r', { run: runner(new Error('no gh'), new Error('unset')) })).toBeNull();
  });
});

describe('noteBotRepoDefaultBranch', () => {
  it('records the name for the worker settings and reads a repository once per TTL', async () => {
    let now = 1_000;
    const run = runner('develop\n', '');
    expect(await noteBotRepoDefaultBranch('/r', { run, dir, now: () => now })).toEqual({ name: 'develop', recorded: true });
    expect(readBotWorkerDefaultBranches(dir)).toEqual(['develop']);
    await noteBotRepoDefaultBranch('/r', { run, dir, now: () => now });
    expect(run).toHaveBeenCalledTimes(1);
    now += DEFAULT_BRANCH_TTL_MS;
    await noteBotRepoDefaultBranch('/r', { run, dir, now: () => now });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('an unread branch records nothing (main and master stay covered) and is read again next time', async () => {
    const run = runner(new Error('x'), new Error('y'));
    const note = await noteBotRepoDefaultBranch('/r', { run, dir });
    expect(note).toEqual({ name: null, recorded: false });
    expect(defaultBranchRefusal(note)).toBeNull();
    expect(readBotWorkerDefaultBranches(dir)).toEqual([]);
    await noteBotRepoDefaultBranch('/r', { run, dir });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('a branch no rule can hold, or a failed write, refuses the launch', async () => {
    const odd = await noteBotRepoDefaultBranch('/odd', { run: runner('dev*', ''), dir });
    expect(odd).toEqual({ name: 'dev*', recorded: false });
    expect(defaultBranchRefusal(odd)).toContain('cannot be kept');
    const blocked = path.join(dir, 'file');
    fs.writeFileSync(blocked, 'x');
    const unwritable = await noteBotRepoDefaultBranch('/w', { run: runner('develop', ''), dir: blocked });
    expect(defaultBranchRefusal(unwritable)).toContain('cannot be kept');
    expect(defaultBranchRefusal(await noteBotRepoDefaultBranch('/m', { run: runner('main', ''), dir }))).toBeNull();
  });

  it('a file that lost the branch gets it back on the next launch', async () => {
    const run = runner('develop', '');
    await noteBotRepoDefaultBranch('/r', { run, dir });
    fs.writeFileSync(path.join(dir, 'factory', 'worker-default-branches.json'), '{nope');
    expect(readBotWorkerDefaultBranches(dir)).toEqual([]);
    await noteBotRepoDefaultBranch('/r', { run, dir });
    expect(readBotWorkerDefaultBranches(dir)).toEqual(['develop']);
  });
});
