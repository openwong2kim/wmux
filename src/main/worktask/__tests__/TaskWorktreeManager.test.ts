// ─── TaskWorktreeManager 단위 (J1 §3 D3) ──────────────────────────────
//
// 전용 루트 suffix 파생·직렬 큐·dirty 거부·에지 fail-closed·경로 길이. git은
// 주입 runGit fake로 시뮬레이션하고, fs 경로는 실 temp 디렉토리로 확인한다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RunGitOptions } from '../TaskWorktreeManager';

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

// 각 테스트가 env(HOME/suffix)를 세팅한 뒤 모듈을 import해야 constants가 반영된다.
async function loadModule() {
  return await import('../TaskWorktreeManager');
}

/** path.join()이 win32에서 '/'까지 '\\'로 정규화하므로, 슬래시 리터럴 비교 전에 양쪽을 통일한다. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** git fake: rev-parse/status/worktree 등 인자별 응답 스크립트. */
function makeGitFake(script: (args: string[], cwd: string) => { stdout?: string; stderr?: string } | Error) {
  // Typed with the optional third (per-call options) parameter so tests can read it back.
  return vi.fn<(args: string[], cwd: string, opts?: RunGitOptions) => Promise<{ stdout: string; stderr: string }>>(
    async (args, cwd) => {
      const r = script(args, cwd);
      if (r instanceof Error) throw r;
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  );
}

/** 정상 repo git fake — toplevel·non-bare·branch 부재·worktree add 성공. */
function healthyRepoGit(repoRoot: string) {
  return makeGitFake((args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
    if (args[0] === 'rev-parse' && args.includes('--is-bare-repository')) return { stdout: 'false\n' };
    if (args[0] === 'rev-parse' && args.includes('--verify')) return new Error('unknown revision'); // 브랜치 부재
    if (args[0] === 'worktree' && args[1] === 'add') return { stdout: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') return { stdout: '' };
    if (args[0] === 'status') return { stdout: '' };
    return { stdout: '' };
  });
}

describe('slug 파생 (§3)', () => {
  it('taskSlug = titleSlug(24자)-taskId말미8자', async () => {
    const { buildTaskSlug } = await loadModule();
    const slug = buildTaskSlug('Ship the Widget!', 'wtask-abc123-deadbeef');
    expect(slug).toBe('ship-the-widget-deadbeef');
  });
  it('title이 비면 taskId 접미사만', async () => {
    const { buildTaskSlug } = await loadModule();
    expect(buildTaskSlug('!!!', 'wtask-x-12345678')).toBe('12345678');
  });
  it('긴 title은 24자로 절단', async () => {
    const { titleToSlug } = await loadModule();
    expect(titleToSlug('a'.repeat(50)).length).toBeLessThanOrEqual(24);
  });
});

describe('preflight — 전용 루트 suffix 파생 (§3 C4)', () => {
  it('경로가 getWmuxHomeDir() 하위 worktrees/{repoHash}/{slug}로 파생된다', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({ runGit: healthyRepoGit(repoRoot) });
    const res = await mgr.preflight(repoRoot, 'My Task', 'wtask-x-abcd1234');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(toPosix(res.plan.worktreePath).startsWith(`${toPosix(home)}/.wmux/worktrees/`)).toBe(true);
    expect(toPosix(res.plan.worktreePath).endsWith('/my-task-abcd1234')).toBe(true);
    expect(res.plan.branch).toBe('wtask/my-task-abcd1234');
    // metaDir은 worktree 밖(.meta) — diff 청정성.
    expect(toPosix(res.plan.metaDir)).toContain('/.meta/');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('suffix(dev)가 루트에 상속된다', async () => {
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

  // J3 §1·§3 — metaDirForWorktree는 worktreePath 하나로 preflight의 metaDir을
  // 되찾는다(정리 스캔 task.json 역추적·재발사 prompt.md 실존 검사의 단일 출처).
  it('metaDirForWorktree(worktreePath)가 preflight의 metaDir과 정합한다', async () => {
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

describe('preflight — 에지 fail-closed (§3)', () => {
  it('비 repo 거부', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const mgr = new TaskWorktreeManager({
      runGit: makeGitFake(() => new Error('fatal: not a git repository')),
    });
    const res = await mgr.preflight('/tmp/x', 'T', 'wtask-x-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a git repository/);
  });

  it('bare repo 거부', async () => {
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

  it('서브모듈 repo 거부(.gitmodules 존재)', async () => {
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

  it('LFS repo 거부(.gitattributes filter=lfs)', async () => {
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

  it('경로 길이(260자) 초과 거부', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    // slug는 24+8 캡이라 title로는 260 초과 불가 — HOME을 아주 긴 경로로 바꿔
    // 루트를 부풀린다.
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

describe('createWorktree — 브랜치 충돌 (§3)', () => {
  it('기존 브랜치가 있으면 명시 에러', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const git = makeGitFake((args) => {
      if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
      if (args.includes('--is-bare-repository')) return { stdout: 'false\n' };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { stdout: 'exists\n' }; // 브랜치 존재
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

  it('checkBranchConflict 옵션이면 preflight가 기존 브랜치를 선차단한다 (F3)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-'));
    const { TaskWorktreeManager } = await loadModule();
    const git = makeGitFake((args) => {
      if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` };
      if (args.includes('--is-bare-repository')) return { stdout: 'false\n' };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { stdout: 'exists\n' }; // 브랜치 존재
      return { stdout: '' };
    });
    const mgr = new TaskWorktreeManager({ runGit: git });
    // 옵션 없으면 통과(충돌은 createWorktree가 잡음).
    const ok = await mgr.preflight(repoRoot, 'T', 'wtask-x-abcd1234');
    expect(ok.ok).toBe(true);
    // 옵션 켜면 preflight 자체가 거부.
    const rejected = await mgr.preflight(repoRoot, 'T', 'wtask-x-abcd1234', { checkBranchConflict: true });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatch(/branch already exists/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe('removeWorktree — dirty 보존 (§3)', () => {
  it('dirty면 제거 거부 + preserved', async () => {
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
    expect(removeCalls).toHaveLength(0); // 강제 삭제 안 함
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('clean이면 제거', async () => {
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

describe('per-repo 직렬 큐 (§3 index.lock 경합 차단)', () => {
  it('같은 repoHash의 create는 겹치지 않고 순차 실행된다', async () => {
    const { TaskWorktreeManager } = await loadModule();
    let active = 0;
    let maxActive = 0;
    // worktree add를 지연시켜 동시성을 관측한다. 직렬 큐면 maxActive는 1.
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
    expect(maxActive).toBe(1); // 직렬 — 동시 실행 0
  });
});

describe('T3 worktree base — origin default branch, --no-track, HEAD fallback', () => {
  /** git fake for base resolution: `refs` are the remote-tracking refs that exist;
   *  `originHead` is what origin/HEAD points at (absent = unset). */
  function baseGit(opts: { originHead?: string; refs?: string[]; fetchFails?: Error; refsAfterFetch?: string[] }) {
    let fetched = false;
    return makeGitFake((args) => {
      if (args[0] === 'symbolic-ref') {
        return opts.originHead ? { stdout: `${opts.originHead}\n` } : new Error('not a symbolic ref');
      }
      if (args[0] === 'fetch') {
        if (opts.fetchFails) return opts.fetchFails;
        fetched = true;
        return { stdout: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        const ref = (args[args.length - 1] ?? '').replace(/\^\{commit\}$/, '');
        const known = fetched && opts.refsAfterFetch ? opts.refsAfterFetch : (opts.refs ?? []);
        return known.includes(ref) ? { stdout: 'abc123\n' } : new Error('unknown revision');
      }
      return { stdout: '' };
    });
  }

  it('uses origin/HEAD, fetches that branch once with a short no-prompt timeout, returns the qualified ref', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const git = baseGit({ originHead: 'refs/remotes/origin/trunk', refs: ['refs/remotes/origin/trunk'] });
    const mgr = new TaskWorktreeManager({ runGit: git });
    const base = await mgr.resolveBase('/repo');
    expect(base).toEqual({ ref: 'refs/remotes/origin/trunk' });
    const fetches = git.mock.calls.filter((c) => c[0][0] === 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0][0]).toEqual(['fetch', 'origin', 'trunk']);
    expect(fetches[0][2]).toEqual({ timeoutMs: 10000, noPrompt: true });
  });

  it('falls back to origin/main, then origin/master, when origin/HEAD is unset', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const mainMgr = new TaskWorktreeManager({ runGit: baseGit({ refs: ['refs/remotes/origin/main'] }) });
    expect(await mainMgr.resolveBase('/repo')).toEqual({ ref: 'refs/remotes/origin/main' });
    const masterMgr = new TaskWorktreeManager({ runGit: baseGit({ refs: ['refs/remotes/origin/master'] }) });
    expect(await masterMgr.resolveBase('/repo')).toEqual({ ref: 'refs/remotes/origin/master' });
  });

  it('no resolvable default branch → HEAD fallback with a warning, and no fetch', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const git = baseGit({});
    const base = await new TaskWorktreeManager({ runGit: git }).resolveBase('/repo');
    expect(base.ref).toBeUndefined();
    expect(base.warning).toMatch(/default branch of remote "origin"/);
    expect(base.warning).toMatch(/local HEAD/);
    expect(git.mock.calls.some((c) => c[0][0] === 'fetch')).toBe(false);
  });

  it('a failed fetch → HEAD fallback with the git error in the warning (stale origin ref is not used)', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const err = Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access remote\nmore' });
    const git = baseGit({ originHead: 'refs/remotes/origin/main', refs: ['refs/remotes/origin/main'], fetchFails: err });
    const base = await new TaskWorktreeManager({ runGit: git }).resolveBase('/repo');
    expect(base.ref).toBeUndefined();
    expect(base.warning).toContain('git fetch origin main failed (fatal: unable to access remote)');
  });

  it('a fetch timeout is reported as such', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const err = Object.assign(new Error('Command failed'), { killed: true });
    const git = baseGit({ originHead: 'refs/remotes/origin/main', refs: ['refs/remotes/origin/main'], fetchFails: err });
    const base = await new TaskWorktreeManager({ runGit: git }).resolveBase('/repo');
    expect(base.warning).toContain('(timed out)');
  });

  it('the ref missing after the fetch → HEAD fallback with a warning', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const git = baseGit({ refs: ['refs/remotes/origin/main'], refsAfterFetch: [] });
    const base = await new TaskWorktreeManager({ runGit: git }).resolveBase('/repo');
    expect(base.ref).toBeUndefined();
    expect(base.warning).toMatch(/does not exist after git fetch origin main/);
  });

  it('createWorktree with a base ref adds --no-track and the explicit start point', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const git = healthyRepoGit('/repo');
    const mgr = new TaskWorktreeManager({ runGit: git });
    const plan = { repoRoot: '/repo', repoHash: 'h', taskSlug: 's', metaDir: '/m', worktreePath: '/wt/s', branch: 'wtask/s' };
    const res = await mgr.createWorktree(plan, 'refs/remotes/origin/main');
    expect(res.ok).toBe(true);
    const add = git.mock.calls.find((c) => c[0][0] === 'worktree' && c[0][1] === 'add');
    expect(add?.[0]).toEqual(['worktree', 'add', '--no-track', path.resolve('/wt/s'), '-b', 'wtask/s', 'refs/remotes/origin/main']);
  });

  it('createWorktree without a base ref keeps the HEAD argv unchanged', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const git = healthyRepoGit('/repo');
    const mgr = new TaskWorktreeManager({ runGit: git });
    const plan = { repoRoot: '/repo', repoHash: 'h', taskSlug: 's', metaDir: '/m', worktreePath: '/wt/s', branch: 'wtask/s' };
    await mgr.createWorktree(plan);
    const add = git.mock.calls.find((c) => c[0][0] === 'worktree' && c[0][1] === 'add');
    expect(add?.[0]).toEqual(['worktree', 'add', path.resolve('/wt/s'), '-b', 'wtask/s']);
  });

  it('real git: the task branch starts at the fetched origin tip, not the stale local checkout, with no upstream', async () => {
    const { TaskWorktreeManager } = await loadModule();
    const { execFileSync } = await import('node:child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-twm-base-'));
    try {
      const origin = path.join(root, 'origin.git');
      git(root, 'init', '--bare', origin);
      const seed = path.join(root, 'seed');
      git(root, 'clone', origin, seed);
      git(seed, 'commit', '--allow-empty', '-m', 'one');
      git(seed, 'push', 'origin', 'HEAD:main');
      const repo = path.join(root, 'repo');
      git(root, 'clone', origin, repo);
      // The owner is on a feature branch; origin moves on after the clone.
      git(repo, 'checkout', '-b', 'feature');
      git(repo, 'commit', '--allow-empty', '-m', 'local only');
      git(seed, 'commit', '--allow-empty', '-m', 'two');
      git(seed, 'push', 'origin', 'HEAD:main');
      const originTip = git(seed, 'rev-parse', 'HEAD');

      const mgr = new TaskWorktreeManager();
      const base = await mgr.resolveBase(repo);
      expect(base).toEqual({ ref: 'refs/remotes/origin/main' });
      const wt = path.join(root, 'wt');
      const res = await mgr.createWorktree(
        { repoRoot: repo, repoHash: 'real', taskSlug: 's', metaDir: path.join(root, 'm'), worktreePath: wt, branch: 'wtask/s' },
        base.ref,
      );
      expect(res.ok).toBe(true);
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(originTip);
      // --no-track: the task branch has no upstream to pull from or push to by accident.
      expect(() => git(repo, 'config', '--get', 'branch.wtask/s.merge')).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
