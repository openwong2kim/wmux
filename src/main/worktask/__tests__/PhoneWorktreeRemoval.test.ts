import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { deletePhoneBranch, phoneWorktreeDir, removePhoneWorktree } from '../PhoneWorktreeRemoval';
import { windowsDirectoryHold, type DirectoryHold } from '../../../shared/directoryHold';

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

  // A shell that `cd`'d into the worktree without its cwd being reported (a
  // cmd.exe prompt is not scraped) still holds it on Windows: git would delete
  // every file and then fail on the directory itself.
  it.runIf(process.platform === 'win32')('refuses a worktree a process holds, in it or below it, unreported', async () => {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'kept.txt'), 'kept');
    git(repo, 'add', 'src/kept.txt');
    git(repo, 'commit', '-q', '-m', 'file');
    const dir = add('held');
    const deps = { root, livePaneCwds: async () => [] };
    const intact = () => {
      expect(fs.readFileSync(path.join(dir, 'src', 'kept.txt'), 'utf8')).toBe('kept');
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('phone-held');
    };
    // A new process holds its current directory a moment after it starts, and
    // lets go a moment after it exits: wait for Windows to say so each time.
    const holding = (hold: DirectoryHold) =>
      vi.waitFor(async () => expect(await windowsDirectoryHold(dir)).toBe(hold), { timeout: 10_000, interval: 50 });
    for (const [cwd, hold, answer] of [
      [dir, 'in-use', { ok: false, reason: 'in-use' }],
      [path.join(dir, 'src'), 'refused', { ok: false, reason: 'held' }],
    ] as const) {
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
      try {
        await once(holder, 'spawn');
        await holding(hold);
        expect(await removePhoneWorktree(dir, false, deps)).toEqual(answer);
        expect(await removePhoneWorktree(dir, true, deps)).toEqual(answer);
        intact();
      } finally {
        holder.kill();
        await once(holder, 'exit');
      }
      await holding('free');
    }
    expect(await removePhoneWorktree(dir, false, deps)).toMatchObject({ ok: true, branch: 'phone/held' });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('asks the directory probe after the pane check, and removes nothing it holds or refuses', async () => {
    const dir = add('probed');
    const seen: string[] = [];
    const probe = (hold: DirectoryHold) => async (d: string) => { seen.push(d); return hold; };
    expect(await removePhoneWorktree(dir, true, { root, livePaneCwds: async () => [], directoryHold: probe('in-use') }))
      .toEqual({ ok: false, reason: 'in-use' });
    expect(await removePhoneWorktree(dir, true, { root, livePaneCwds: async () => [], directoryHold: probe('refused') }))
      .toEqual({ ok: false, reason: 'held' });
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('phone-probed');
    expect(await removePhoneWorktree(dir, false, { root, livePaneCwds: async () => [dir], directoryHold: probe('free') }))
      .toEqual({ ok: false, reason: 'in-use' });
    expect(seen).toEqual([dir, dir]);
    expect(await removePhoneWorktree(dir, false, { root, livePaneCwds: async () => [], directoryHold: probe('free') }))
      .toMatchObject({ ok: true, branch: 'phone/probed' });
  });

  it('probes with a no-op rename: an idle directory is free and unchanged, a missing one is not a hold', async () => {
    const dir = add('idle');
    const before = fs.statSync(dir, { bigint: true });
    expect(await windowsDirectoryHold(dir)).toBe('free');
    const after = fs.statSync(dir, { bigint: true });
    expect([after.mtimeNs, after.ctimeNs, after.birthtimeNs, after.mode]).toEqual([before.mtimeNs, before.ctimeNs, before.birthtimeNs, before.mode]);
    expect(await windowsDirectoryHold(path.join(root, HASH, 'phone-gone'))).toBe('free');
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
