// ─── TaskWorktreeManager unit tests (J1 §3 D3) ──────────────────────────────
//
// Dedicated root suffix derivation·serial queue·dirty reject·edge fail-closed·path length. git is
// simulated via injected runGit fake; fs paths verified with real temp directories.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevSuffix: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-twm-home-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevSuffix = process.env.WMUX_DATA_SUFFIX;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
  else process.env.WMUX_DATA_SUFFIX = prevSuffix;
  fs.rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

// Each test must set env (HOME/suffix) before importing the module so constants apply.
async function loadModule() {
  return await import('../TaskWorktreeManager');
}

/** path.join() normalizes '/' to '\\' on win32 — unify both sides before slash literal compare. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** git fake: per-arg response script for rev-parse/status/worktree etc. */
function makeGitFake(script: (args: string[], cwd: string) => { stdout?: string; stderr?: string } | Error) {
  return vi.fn(async (args: string[], cwd: string) => {
    const r = script(args, cwd);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  });
}

/** Normal repo git fake — toplevel·non-bare·no branch·worktree add succeeds. */
function healthyRepoGit(repoRoot: string) {
  return makeGitFake((args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
    if (args[0] === 'rev-parse' && args.includes('--is-bare-repository')) return { stdout: 'false\n' };
    if (args[0] === 'rev-parse' && args.includes('--verify')) return new Error('unknown revision'); // branch absent
    if (args[0] === 'worktree' && args[1] === 'add') return { stdout: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') return { stdout: '' };
    if (args[0] === 'status') return { stdout: '' };
    return { stdout: '' };
  });
}

describe('slug derivation (§3)', () => {
  it('taskSlug = titleSlug(24 chars)-taskId suffix 8 chars', async () => {
    const { buildTaskSlug } = await loadModule();
    const slug = buildTaskSlug('Ship the Widget!', 'wtask-abc123-deadbeef');
    expect(slug).toBe('ship-the-widget-deadbeef');
  });
  it('empty title → taskId suffix only', async () => {
    const { buildTaskSlug } = await loadModule();
    expect(buildTaskSlug('!!!', 'wtask-x-12345678')).toBe('12345678');
  });
  it('long title is truncated to 24 chars', async () => {
    const { titleToSlug } = await loadModule();
    expect(titleToSlug('a'.repeat(50)).length).toBeLessThanOrEqual(24);
  });
});

describe('preflight — dedicated root suffix derivation (§3 C4)', () => {
  it('path derives under getWmuxHomeDir() worktrees/{repoHash}/{slug}', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'My Task', 'wtask-x-abcd1234');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(toPosix(res.plan.worktreePath).startsWith(`${toPosix(home)}/.wmux/worktrees/`)).toBe(true);
    expect(toPosix(res.plan.worktreePath).endsWith('/my-task-abcd1234')).toBe(true);
    expect(res.plan.branch).toBe('wtask/my-task-abcd1234');
    // metaDir is outside worktree (.meta) — diff cleanliness.
    expect(toPosix(res.plan.metaDir)).toContain('/.meta/');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('suffix (dev) is inherited by root', async () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'T', 'wtask-x-abcd1234');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(toPosix(res.plan.worktreePath).startsWith(`${toPosix(home)}/.wmux-dev/worktrees/`)).toBe(true);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  // J3 §1·§3 — metaDirForWorktree recovers preflight metaDir from worktreePath alone
  // (single source for cleanup-scan task.json backtrace·relaunch prompt.md existence check).
  it('metaDirForWorktree(worktreePath) matches preflight metaDir', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager, metaDirForWorktree } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'My Task', 'wtask-x-abcd1234');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(metaDirForWorktree(res.plan.worktreePath)).toBe(res.plan.metaDir);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe('preflight — edge fail-closed (§3)', () => {
  it('rejects non-repo', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({
      runGit: makeGitFake(() => new Error('fatal: not a git repository')),
    });
    const res = await mgr.preflight('/tmp/x', 'T', 'wtask-x-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a git repository/);
  });

  it('rejects bare repo', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({
      runGit: makeGitFake((args) => {
        if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
        if (args.includes('--is-bare-repository')) return { stdout: 'true\n' };
        return { stdout: '' };
      }),
    });
    const res = await mgr.preflight(repoRoot, 'T', 'wtask-x-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/bare/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('rejects submodule repo (.gitmodules present)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    fs.writeFileSync(path.join(repoRoot, '.gitmodules'), '[submodule "x"]\n');
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'T', 'wtask-x-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/submodule/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('rejects LFS repo (.gitattributes filter=lfs)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    fs.writeFileSync(path.join(repoRoot, '.gitattributes'), '*.bin filter=lfs diff=lfs\n');
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'T', 'wtask-x-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/LFS/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('rejects path length exceeding 260 chars', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    // slug is 24+8 capped so title alone cannot exceed 260 — inflate root with very long HOME.
    const deepHome = path.join(home, 'a'.repeat(250));
    fs.mkdirSync(deepHome, { recursive: true });
    process.env.HOME = deepHome;
    process.env.USERPROFILE = deepHome;
    vi.resetModules();
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'Some Task', 'wtask-x-abcd1234');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/exceeds 260/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe('createWorktree — branch conflict (§3)', () => {
  it('explicit error when branch already exists', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const git = makeGitFake((args) => {
      if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
      if (args.includes('--is-bare-repository')) return { stdout: 'false\n' };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { stdout: 'exists\n' }; // branch exists
      return { stdout: '' };
    });
    const mgr = new TaskWorktreeManager({ runGit: git });
    const pf = await mgr.preflight(repoRoot, 'T', 'wtask-x-abcd1234');
    expect(pf.ok).toBe(true);
    if (!pf.ok) return;
    const res = await mgr.createWorktree(pf.plan);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/branch already exists/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('preflight blocks existing branch when checkBranchConflict option set (F3)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const git = makeGitFake((args) => {
      if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
      if (args.includes('--is-bare-repository')) return { stdout: 'false\n' };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { stdout: 'exists\n' }; // branch exists
      return { stdout: '' };
    });
    const mgr = new TaskWorktreeManager({ runGit: git });
    // without option, passes (createWorktree catches conflicts).
    const ok = await mgr.preflight(repoRoot, 'T', 'wtask-x-abcd1234');
    expect(ok.ok).toBe(true);
    // with option on, preflight itself rejects.
    const rejected = await mgr.preflight(repoRoot, 'T', 'wtask-x-abcd1234', { checkBranchConflict: true });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatch(/branch already exists/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe('removeWorktree — dirty preservation (§3)', () => {
  it('dirty → removal rejected + preserved', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const removeCalls: string[] = [];
    const git = makeGitFake((args) => {
      if (args[0] === 'status') return { stdout: ' M file.txt\n' }; // dirty
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls.push('remove');
        return { stdout: '' };
      }
      return { stdout: '' };
    });
    const mgr = new TaskWorktreeManager({ runGit: git });
    const res = await mgr.removeWorktree(repoRoot, 'hash1', '/wt/some');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.preserved).toBe(true);
    expect(removeCalls).toHaveLength(0); // no forced delete
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('clean → removed', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const git = makeGitFake((args) => {
      if (args[0] === 'status') return { stdout: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { stdout: '' };
      return { stdout: '' };
    });
    const mgr = new TaskWorktreeManager({ runGit: git });
    const res = await mgr.removeWorktree('/repo', 'hash1', '/wt/some');
    expect(res.ok).toBe(true);
  });
});

describe('per-repo serial queue (§3 index.lock contention guard)', () => {
  it('creates for same repoHash run sequentially without overlap', async () => {
    const { TaskWorktreeManager } = await loadModule();
    let active = 0;
    let maxActive = 0;
    // delay worktree add to observe concurrency. serial queue → maxActive is 1.
    const mgr = new TaskWorktreeManager({
      runGit: async (args) => {
        if (args[0] === 'rev-parse' && args.includes('--verify')) throw new Error('absent');
        if (args[0] === 'worktree' && args[1] === 'add') {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }
        return { stdout: '', stderr: '' };
      },
    });
    const base = {
      repoRoot: '/repo',
      repoHash: 'sameHash',
      taskSlug: 's',
      metaDir: '/m',
    };
    await Promise.all([
      mgr.createWorktree({ ...base, worktreePath: '/wt/s1', branch: 'wtask/s1' }),
      mgr.createWorktree({ ...base, worktreePath: '/wt/s2', branch: 'wtask/s2' }),
      mgr.createWorktree({ ...base, worktreePath: '/wt/s3', branch: 'wtask/s3' }),
    ]);
    expect(maxActive).toBe(1); // serial — zero concurrent runs
  });
});
