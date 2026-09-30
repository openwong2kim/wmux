import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deletePhoneBranch, phoneWorktreeDir, removePhoneWorktree } from '../PhoneWorktreeRemoval';

const HASH = 'abc123def456';
let base: string;
let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
const add = (slug: string) => {
  const dir = path.join(root, HASH, `phone-${slug}`);
  git(repo, 'worktree', 'add', '-q', '-b', `phone/${slug}`, dir);
  return dir;
};

describe('removing a phone worktree from the desktop cleanup list', { timeout: 30_000 }, () => {
  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-rm-')));
    root = path.join(base, 'worktrees');
    fs.mkdirSync(path.join(root, HASH), { recursive: true });
    repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  it('accepts only the daemon-created shape, with no link on the way', () => {
    const dir = add('ok');
    expect(phoneWorktreeDir(root, dir)).toBe(dir);
    for (const bad of [repo, path.join(root, HASH), path.join(root, HASH, 'task-slug'), path.join(root, 'nothex', 'phone-ok'),
      path.join(root, HASH, 'phone-ok', 'sub'), path.join(root, HASH, 'phone-Bad'), `${root}/${HASH}/../${HASH}/phone-ok/..`]) {
      expect(phoneWorktreeDir(root, bad)).toBeNull();
    }
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, HASH, 'phone-link'), 'dir');
    expect(phoneWorktreeDir(root, path.join(root, HASH, 'phone-link'))).toBeNull();
    // A root reached through a link (a linked home) accepts either spelling.
    const linkedRoot = path.join(base, 'linked-root');
    fs.symlinkSync(root, linkedRoot, 'dir');
    expect(phoneWorktreeDir(linkedRoot, dir)).toBe(dir);
    expect(phoneWorktreeDir(linkedRoot, path.join(linkedRoot, HASH, 'phone-ok'))).toBe(dir);
  });

  it('refuses while a pane runs inside, asks before discarding changes, then deletes the branch on request', async () => {
    const dir = add('work');
    const deps = (cwds: string[]) => ({ root, livePaneCwds: async () => cwds });
    expect(await removePhoneWorktree(dir, false, deps([path.join(dir, 'src')]))).toEqual({ ok: false, reason: 'in-use' });
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'work');
    expect(await removePhoneWorktree(dir, false, deps([]))).toEqual({ ok: false, reason: 'dirty' });
    expect(fs.existsSync(path.join(dir, 'mine.txt'))).toBe(true);
    const removed = await removePhoneWorktree(dir, true, deps([]));
    expect(removed).toMatchObject({ ok: true, branch: 'phone/work' });
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'phone/work')).toContain('phone/work');
    if (!removed.ok || !removed.repo) throw new Error('unreachable');
    expect(await deletePhoneBranch(removed.repo, 'main')).toMatchObject({ ok: false });
    expect(await deletePhoneBranch(removed.repo, 'phone/work')).toEqual({ ok: true });
    expect(git(repo, 'branch', '--list', 'phone/work')).toBe('');
  });

  it('removes a clean worktree without asking, and a leftover directory only when forced', async () => {
    const clean = add('clean');
    expect(await removePhoneWorktree(clean, false, { root, livePaneCwds: async () => [] })).toMatchObject({ ok: true, branch: 'phone/clean' });
    const leftover = path.join(root, HASH, 'phone-leftover');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'partial'), '');
    expect(await removePhoneWorktree(leftover, false, { root, livePaneCwds: async () => [] })).toEqual({ ok: false, reason: 'unregistered' });
    expect(await removePhoneWorktree(leftover, true, { root, livePaneCwds: async () => [] })).toEqual({ ok: true });
    expect(fs.existsSync(leftover)).toBe(false);
  });
});
