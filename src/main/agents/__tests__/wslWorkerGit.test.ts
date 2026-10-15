import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { applyWslWorkerGit, autocrlfToPass, withWslWorkerGit, wslWorkerGitPlan } from '../wslWorkerGit';
import { WSL_TASK_GIT_ENV } from '../../../shared/wslIntegration';

const CWD = 'C:\\Users\\me\\.wmux-e2e\\worktrees\\repo\\t-1';
const DOT_GIT = 'gitdir: D:/wmux-work/repo/.git/worktrees/t-1\n';

describe('wslWorkerGitPlan (#2231)', () => {
  it('an absolute Windows gitdir and worktree become their /mnt paths', () => {
    expect(wslWorkerGitPlan(CWD, DOT_GIT, null)).toEqual({
      gitDir: '/mnt/d/wmux-work/repo/.git/worktrees/t-1',
      workTree: '/mnt/c/Users/me/.wmux-e2e/worktrees/repo/t-1',
    });
    expect(wslWorkerGitPlan(`${CWD}\\`, 'gitdir: D:\\wmux-work\\repo\\.git\\worktrees\\t-1\r\n', null)?.gitDir)
      .toBe('/mnt/d/wmux-work/repo/.git/worktrees/t-1');
  });

  it('a repository inside the pane\'s distro: the gitdir is its Linux path', () => {
    const inWsl = 'gitdir: //wsl.localhost/Ubuntu/home/dev/repo/.git/worktrees/t-1\n';
    expect(wslWorkerGitPlan(CWD, inWsl, 'Ubuntu')?.gitDir).toBe('/home/dev/repo/.git/worktrees/t-1');
    expect(wslWorkerGitPlan(CWD, inWsl, null)?.gitDir).toBe('/home/dev/repo/.git/worktrees/t-1');
    // Another distro's repository is not on this pane's filesystem.
    expect(wslWorkerGitPlan(CWD, inWsl, 'Debian')).toBeNull();
  });

  it('nothing to fix: not a drive folder, a .git folder, a relative gitdir, no gitdir line', () => {
    expect(wslWorkerGitPlan('/home/dev/wt', DOT_GIT, null)).toBeNull();
    expect(wslWorkerGitPlan('\\\\server\\share\\wt', DOT_GIT, null)).toBeNull();
    expect(wslWorkerGitPlan(CWD, null, null)).toBeNull();
    expect(wslWorkerGitPlan(CWD, 'gitdir: ../repo/.git/worktrees/t-1\n', null)).toBeNull();
    expect(wslWorkerGitPlan(CWD, 'nothing here\n', null)).toBeNull();
  });
});

describe('the pane environment', () => {
  const plan = { gitDir: '/mnt/d/r/.git/worktrees/t-1', workTree: '/mnt/c/w/t-1' };

  it('reaches Linux only (WSLENV /u), keeping the WSLENV entries already there', () => {
    const env: Record<string, string> = { WSLENV: 'FOO/p:BAR', GIT_CONFIG_COUNT: '1' };
    applyWslWorkerGit(env, plan, 'true\n');
    expect(env).toMatchObject({
      WMUX_WSL_GIT_DIR: plan.gitDir,
      WMUX_WSL_GIT_WORK_TREE: plan.workTree,
      WMUX_WSL_GIT_AUTOCRLF: 'true',
      WSLENV: 'FOO/p:BAR:WMUX_WSL_GIT_DIR/u:WMUX_WSL_GIT_WORK_TREE/u:WMUX_WSL_GIT_AUTOCRLF/u',
      // The Windows side's own list is not touched.
      GIT_CONFIG_COUNT: '1',
    });
    // No GIT_* on the Windows side: a Windows git started from the pane is unaffected.
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
  });

  it('core.autocrlf whenever it is set, false included; nothing when unset', () => {
    expect(autocrlfToPass('input')).toBe('input');
    expect(autocrlfToPass('false\n')).toBe('false');
    expect(autocrlfToPass('')).toBeNull();
    expect(autocrlfToPass(null)).toBeNull();
    const env: Record<string, string> = {};
    applyWslWorkerGit(env, plan, null);
    expect(env.WMUX_WSL_GIT_AUTOCRLF).toBeUndefined();
    expect(env.WSLENV).toBe('WMUX_WSL_GIT_DIR/u:WMUX_WSL_GIT_WORK_TREE/u');
  });

  it('reads the .git file and Git for Windows\' effective core.autocrlf in the worktree', async () => {
    const env: Record<string, string> = {};
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const changed = await withWslWorkerGit(env, CWD, null, {
      readDotGit: (cwd) => (cwd === CWD ? DOT_GIT : null),
      git: async (args, cwd) => { calls.push({ args, cwd }); return { stdout: 'true\n', stderr: '', code: 0 }; },
    });
    expect(changed).toBe(true);
    expect(calls).toEqual([{ args: ['config', '--get', 'core.autocrlf'], cwd: CWD }]);
    expect(env.WMUX_WSL_GIT_AUTOCRLF).toBe('true');
    // Unset (git exits 1): nothing passed.
    const unset: Record<string, string> = {};
    await withWslWorkerGit(unset, CWD, null, { readDotGit: () => DOT_GIT, git: async () => ({ stdout: '', stderr: '', code: 1 }) });
    expect(unset.WMUX_WSL_GIT_AUTOCRLF).toBeUndefined();
    expect(unset.WMUX_WSL_GIT_DIR).toBe('/mnt/d/wmux-work/repo/.git/worktrees/t-1');
    // Nothing to fix: the environment is left alone.
    const none: Record<string, string> = {};
    expect(await withWslWorkerGit(none, '/home/dev/wt', null, { readDotGit: () => DOT_GIT })).toBe(false);
    expect(none).toEqual({});
  });
});

// The bashrc half, run by a real bash (none at /bin/bash on Windows).
describe.skipIf(process.platform === 'win32')('WSL_TASK_GIT_ENV', () => {
  const run = (env: Record<string, string>) => execFileSync('/bin/bash', ['-c', `${WSL_TASK_GIT_ENV}
printf '%s|%s|%s|%s|%s|%s|%s\\n' "\${GIT_DIR-}" "\${GIT_WORK_TREE-}" "\${GIT_CONFIG_COUNT-}" "\${GIT_CONFIG_KEY_0-}" "\${GIT_CONFIG_VALUE_0-}" "\${GIT_CONFIG_KEY_1-}" "\${GIT_CONFIG_VALUE_1-}"`], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  }).trim();
  const where = { WMUX_WSL_GIT_DIR: '/mnt/d/r/.git/worktrees/t 1', WMUX_WSL_GIT_WORK_TREE: '/mnt/c/w/t 1' };

  it('exports GIT_DIR and GIT_WORK_TREE inside Linux', () => {
    expect(run(where)).toBe('/mnt/d/r/.git/worktrees/t 1|/mnt/c/w/t 1|||||');
  });

  it('adds core.autocrlf as the first config entry when there is none', () => {
    expect(run({ ...where, WMUX_WSL_GIT_AUTOCRLF: 'true' })).toBe('/mnt/d/r/.git/worktrees/t 1|/mnt/c/w/t 1|1|core.autocrlf|true||');
  });

  it('appends to a GIT_CONFIG_COUNT list already there, never over it', () => {
    expect(run({ ...where, WMUX_WSL_GIT_AUTOCRLF: 'input', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'me' }))
      .toBe('/mnt/d/r/.git/worktrees/t 1|/mnt/c/w/t 1|2|user.name|me|core.autocrlf|input');
  });

  it('does nothing in an ordinary pane', () => {
    expect(run({ WMUX_WSL_GIT_AUTOCRLF: 'true' })).toBe('||||||');
  });
});
