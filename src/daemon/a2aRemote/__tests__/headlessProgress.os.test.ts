// worktreeProgress against a real repository: HEAD, its commit time, and the
// tracked files that differ from the start commit (committed or not).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRunner } from '../../../main/a2aRemote/spawnWorktree';
import { worktreeProgress } from '../headlessStarter';

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function repo(): { repo: string; g: (...args: string[]) => string; env: Record<string, string> } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-progress-'));
  const global = path.join(dir, 'global.gitconfig');
  fs.writeFileSync(global, '');
  const env = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const g = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, ...env } }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { repo: root, g, env };
}

describe('worktreeProgress', () => {
  it('a fresh worktree: its HEAD, and nothing changed', async () => {
    const r = repo();
    const base = r.g('rev-parse', 'HEAD');
    const got = await worktreeProgress(gitRunner(r.repo, { env: r.env }), base);
    expect(got).toMatchObject({ head: base.slice(0, 12), changedFiles: 0 });
    expect(Number.isFinite(Date.parse(got?.committedAt ?? ''))).toBe(true);
  });

  it('counts committed and uncommitted changes to tracked files since the start commit, not untracked ones', async () => {
    const r = repo();
    const base = r.g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(r.repo, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(r.repo, 'c.txt'), 'c\n');
    r.g('add', '.');
    r.g('commit', '-qm', 'work');
    // Uncommitted, tracked:
    fs.writeFileSync(path.join(r.repo, 'b.txt'), 'b2\n');
    // Untracked: not counted.
    fs.writeFileSync(path.join(r.repo, 'scratch.log'), 'x\n');
    const got = await worktreeProgress(gitRunner(r.repo, { env: r.env }), base);
    expect(got).toMatchObject({ head: r.g('rev-parse', '--short=12', 'HEAD'), changedFiles: 3 });
  });

  it('null when git cannot say (not a repository, or an unknown start commit)', async () => {
    const r = repo();
    expect(await worktreeProgress(gitRunner(r.repo, { env: r.env }), 'f'.repeat(40))).toBeNull();
    expect(await worktreeProgress(gitRunner(dir, { env: r.env }), 'f'.repeat(40))).toBeNull();
  });

  it('a diff summary it cannot read (git in another language) is no count, not zero', async () => {
    const git = async (args: string[]) => (args[0] === 'log'
      ? { code: 0, stdout: `${'a'.repeat(40)}\u00002026-11-24T01:00:00+09:00\n`, stderr: '' }
      : { code: 0, stdout: ' 3 Dateien geändert, 10 Zeilen hinzugefügt(+)\n', stderr: '' });
    expect(await worktreeProgress(git as never, 'b'.repeat(40))).toBeNull();
    const none = async (args: string[]) => (args[0] === 'log'
      ? { code: 0, stdout: `${'a'.repeat(40)}\u00002026-11-24T01:00:00+09:00\n`, stderr: '' }
      : { code: 0, stdout: '', stderr: '' });
    expect(await worktreeProgress(none as never, 'b'.repeat(40))).toMatchObject({ head: 'a'.repeat(12), changedFiles: 0 });
  });
});
