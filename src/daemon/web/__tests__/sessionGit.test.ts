import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SessionGitController, type GitMutation } from '../sessionGit';
import { buildGitEnv, createGitRunner } from '../sessionDiff';
let root: string;
let controller: SessionGitController;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: buildGitEnv(), encoding: 'utf8' }).trim();
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-phone-git-'));
  // Point git's global config at the empty temp root so a runner's own
  // ~/.gitconfig (git-lfs filters on the macOS image) cannot leak in.
  process.env.HOME = root; process.env.USERPROFILE = root;
  git('init', '-b', 'main');
  git('config', 'user.name', 'Phone Test');
  git('config', 'user.email', 'phone@example.invalid');
  controller = new SessionGitController();
});
afterEach(async () => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  await fs.rm(root, { recursive: true, force: true });
});
async function request(action: GitMutation['action'], paths?: string[], message?: string): Promise<GitMutation> {
  const state = await controller.read(root);
  return {requestId:randomUUID(), action, paths, message, expectedHead:state.head, expectedTree:state.tree, expectedRef:state.ref};
}
// Windows runners spawn git slowly enough to blow the 5 s default.
describe('phone Git writes', { timeout: 30_000 }, () => {
  it.skipIf(process.platform === 'win32')('stages literal unusual filenames, unstages initial files, and commits only the reviewed tree', async () => {
    await fs.writeFile(path.join(root, ':(glob)* 한글.txt'), 'first');
    await fs.writeFile(path.join(root, 'other.txt'), 'untouched');
    await controller.mutate(root, await request('stage', [':(glob)* 한글.txt']));
    expect((await controller.read(root)).files.find(f => f.path === 'other.txt')?.status).toBe('??');
    await controller.mutate(root, await request('unstage', [':(glob)* 한글.txt']));
    expect(git('ls-files')).toBe('');
    await controller.mutate(root, await request('stage', [':(glob)* 한글.txt']));
    const commit = await request('commit', undefined, 'Review from phone');
    const result = await controller.mutate(root, commit);
    expect(result.commit).toBe(git('rev-parse', 'HEAD'));
    expect(git('log', '-1', '--format=%s')).toBe('Review from phone');
    expect(git('ls-tree', '--name-only', 'HEAD')).not.toContain('other.txt');
    expect(await controller.mutate(root, commit)).toEqual(result);
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    await expect(controller.mutate(root, {...commit, message:'changed'})).rejects.toMatchObject({tag:'request-id-reused'});
  });
  it('rejects stale staged state and preserves worktree bytes when unstaging', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one');
    await controller.mutate(root, await request('stage', ['one']));
    const stale = await request('commit', undefined, 'stale');
    await fs.writeFile(path.join(root, 'two'), 'two');
    git('add', 'two');
    await expect(controller.mutate(root, stale)).rejects.toMatchObject({tag:'git-state-changed'});
    await controller.mutate(root, await request('commit', undefined, 'initial'));
    await fs.writeFile(path.join(root, 'one'), 'changed');
    await controller.mutate(root, await request('stage', ['one']));
    await controller.mutate(root, await request('unstage', ['one']));
    expect(await fs.readFile(path.join(root, 'one'), 'utf8')).toBe('changed');
    expect((await controller.read(root)).files[0].status).toBe(' M');
  });
  it('refuses a stage whose index moved between the preflight and the write', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one');
    const stage = await request('stage', ['one']);
    // `authorized` runs after the preflight snapshot and before the write — the
    // exact window a desktop terminal can stage in. Only `commit` used to be
    // compare-and-swapped, so this write landed on an unreviewed index.
    await expect(controller.mutate(root, stage, async () => {
      await fs.writeFile(path.join(root, 'two'), 'two');
      git('add', 'two');
      return true;
    })).rejects.toMatchObject({status:409, tag:'git-state-changed'});
    expect(git('ls-files')).toBe('two');
  });
  it('refuses an unstage whose index moved between the preflight and the write', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one');
    git('add', 'one');
    git('commit', '-m', 'initial');
    await fs.writeFile(path.join(root, 'one'), 'changed');
    git('add', 'one');
    const unstage = await request('unstage', ['one']);
    await expect(controller.mutate(root, unstage, async () => {
      await fs.writeFile(path.join(root, 'two'), 'two');
      git('add', 'two');
      return true;
    })).rejects.toMatchObject({status:409, tag:'git-state-changed'});
    expect(git('diff', '--cached', '--name-only').split('\n').sort()).toEqual(['one','two']);
  });
  it('does not execute hooks or signing programs and refuses content filters', async () => {
    const marker = path.join(root, 'hook-ran');
    await fs.writeFile(path.join(root, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, {mode:0o755});
    await fs.writeFile(path.join(root, 'one'), 'one');
    git('config', 'commit.gpgSign', 'true');
    git('config', 'gpg.program', '/does-not-exist');
    await controller.mutate(root, await request('stage', ['one']));
    await controller.mutate(root, await request('commit', undefined, 'safe'));
    await expect(fs.stat(marker)).rejects.toMatchObject({code:'ENOENT'});
    git('config', 'filter.evil.clean', `touch '${marker}'`);
    await expect(controller.read(root)).rejects.toMatchObject({tag:'git-filters-require-desktop'});
    await expect(fs.stat(marker)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('rejects traversal, merge state, detached HEAD and empty commits', async () => {
    await expect(controller.mutate(root, await request('stage', ['../escape']))).rejects.toMatchObject({status:400});
    await expect(controller.mutate(root, await request('commit', undefined, 'empty'))).rejects.toMatchObject({tag:'nothing-staged'});
    await fs.writeFile(path.join(root, '.git/MERGE_HEAD'), 'pending');
    await expect(controller.read(root)).rejects.toMatchObject({tag:'git-operation-in-progress'});
    await fs.unlink(path.join(root, '.git/MERGE_HEAD'));
    await fs.writeFile(path.join(root, 'one'), 'one');
    git('add', 'one'); git('-c', 'commit.gpgSign=false', 'commit', '-m', 'first');
    git('checkout', '--detach');
    await expect(controller.read(root)).rejects.toMatchObject({tag:'git-operation-failed'});
  });
  it('refuses a mutation reviewed on another branch at the same HEAD and tree', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one'); git('add', 'one');
    await controller.mutate(root, await request('commit', undefined, 'initial'));
    // `other` is created at exactly the same commit, so HEAD and the index tree
    // are identical on both branches — only the full ref tells them apart.
    git('branch', 'other');
    await fs.writeFile(path.join(root, 'two'), 'two');
    const stage = await request('stage', ['two']);
    const commit = await request('commit', undefined, 'phone');
    expect(stage.expectedRef).toBe('refs/heads/main');
    git('checkout', 'other');
    const mainBefore = git('rev-parse', 'refs/heads/main');
    const otherBefore = git('rev-parse', 'refs/heads/other');
    await expect(controller.mutate(root, stage)).rejects.toMatchObject({status:409, tag:'git-state-changed'});
    await expect(controller.mutate(root, commit)).rejects.toMatchObject({status:409, tag:'git-state-changed'});
    expect(git('rev-parse', 'refs/heads/main')).toBe(mainBefore);
    expect(git('rev-parse', 'refs/heads/other')).toBe(otherBefore);
    expect(git('diff', '--cached', '--name-only')).toBe('');
  });
  it('refuses a mutation that carries no reviewed ref', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one');
    const {expectedRef, ...withoutRef} = await request('stage', ['one']);
    expect(expectedRef).toBe('refs/heads/main');
    await expect(controller.mutate(root, withoutRef)).rejects.toMatchObject({status:400, tag:'invalid-git-request'});
    await expect(controller.mutate(root, {...withoutRef, expectedRef:'main'})).rejects.toMatchObject({status:400, tag:'invalid-git-request'});
    expect(git('ls-files')).toBe('');
  });
  it('refuses to write once the caller is no longer authorized', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one');
    const stage = await request('stage', ['one']);
    await expect(controller.mutate(root, stage, async () => false)).rejects.toMatchObject({status:401, tag:'authorization-expired'});
    expect(git('ls-files')).toBe('');
    // The refusal is not cached as a receipt, so a re-authorized retry works.
    await controller.mutate(root, stage, async () => true);
    expect(git('ls-files')).toBe('one');
  });
  it('does not overwrite a concurrent branch commit', async () => {
    await fs.writeFile(path.join(root, 'one'), 'one'); git('add', 'one');
    await controller.mutate(root, await request('commit', undefined, 'initial'));
    await fs.writeFile(path.join(root, 'one'), 'next'); git('add', 'one');
    const mutation = await request('commit', undefined, 'phone');
    const real = createGitRunner();
    const racing = new SessionGitController(async (args, cwd) => {
      if (args.includes('update-ref')) git('-c', 'commit.gpgSign=false', 'commit', '-m', 'desktop');
      return real(args, cwd);
    });
    await expect(racing.mutate(root, mutation)).rejects.toMatchObject({tag:'git-operation-failed'});
    expect(git('log', '-1', '--format=%s')).toBe('desktop');
    expect(git('rev-list', '--count', 'HEAD')).toBe('2');
  });
});
