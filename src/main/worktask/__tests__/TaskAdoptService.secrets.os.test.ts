// Adopting a task refuses a secret — against real git: the patch and the
// secret check read one snapshot of the task worktree.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskAdoptService, type AdoptGit } from '../TaskAdoptService';

const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const realGit: AdoptGit = async (args, cwd, env) => {
  try {
    return { code: 0, stderr: '', stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
};

let dir: string;
let repo: string;
let wt: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-adopt-secrets-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  wt = path.join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'wtask/x', wt], repo);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('TaskAdoptService secret guard (real git)', () => {
  it('refuses a secret file even when it disappears from the worktree after the patch was taken', async () => {
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(wt, '.env'), 'X=1\n');
    // The agent removes .env right after the patch is read: the patch still carries it.
    const racing: AdoptGit = async (args, cwd, env) => {
      const r = await realGit(args, cwd, env);
      if (args.includes('--binary')) fs.rmSync(path.join(wt, '.env'), { force: true });
      return r;
    };
    const res = await new TaskAdoptService({ git: racing }).adopt({ taskId: 'wtask-1', worktreePath: wt, commit: true });
    expect(res).toMatchObject({ ok: false, reason: 'secret', secrets: [{ path: '.env', what: 'file', kind: 'env' }] });
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false);
    expect(git(['status', '--porcelain'], wt)).toBe('?? b.txt');
  });

  it('adopts a clean task', async () => {
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    const res = await new TaskAdoptService({ git: realGit }).adopt({ taskId: 'wtask-1', worktreePath: wt, commit: true });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('b\n'); // autocrlf on Windows
  });
});
