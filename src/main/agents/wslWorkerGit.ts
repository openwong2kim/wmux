// ─── #2231 — git for a WSL-shell worker in a task worktree on a Windows drive ─
//
// Git for Windows creates a task worktree with absolute paths: its `.git` file
// says `gitdir: D:/…/.git/worktrees/<name>`. Linux git reads that as a path
// relative to the worktree, so a worker whose pane shell is WSL could not run
// git at all. Relative worktrees would fix the file but turn on
// `extensions.relativeworktrees` in the user's own repository, which every git
// before 2.48 (WSL Ubuntu 24.04 ships 2.43) then refuses to open. So the
// repository is left as it is, and the worker's Linux shell is told where the
// gitdir and the worktree are instead: GIT_DIR / GIT_WORK_TREE as Linux paths
// (the gitdir's `commondir` is relative, `../..`, and resolves under it).
//
// The values reach Linux as WMUX_WSL_GIT_* (WSLENV `/u`: Windows → Linux only)
// and become GIT_* in the pane's bashrc (shared/wslIntegration.ts
// WSL_TASK_GIT_ENV), so no Windows process started from the pane sees a Linux
// GIT_DIR. Git for Windows' effective core.autocrlf goes along: its system
// config sets `true`, the worktree is checked out with CRLF, and Linux git
// without it reads every text file as modified.
//
// The pane's git is pinned to the task worktree (a `git -C <elsewhere>` there
// still works on the task's repository): the pane exists for that task.

import fs from 'node:fs';
import path from 'node:path';
import { toWslPath } from '../../shared/imagePaste';
import { mergeWslEnv } from '../../shared/wsl';
import { taskPushGitTarget } from '../worktask/taskPush';
import { git as runGit, type GitResult } from '../git/git';

export interface WslWorkerGitPlan {
  /** The worktree's gitdir, as Linux sees it. */
  gitDir: string;
  /** The worktree, as Linux sees it. */
  workTree: string;
}

/**
 * Where Linux git finds a Windows-drive task worktree, from its folder and
 * its `.git` file's text. Null when there is nothing to fix: the folder is
 * not on a drive letter (a Linux path or a share), it has a `.git` folder or
 * none, its gitdir is already relative, or the gitdir is in another WSL
 * distro than the pane's (`distro` null: the default one, whose name is not
 * known here). Pure.
 */
export function wslWorkerGitPlan(cwd: string, dotGit: string | null, distro: string | null): WslWorkerGitPlan | null {
  const workTree = toWslPath(cwd);
  if (!workTree || dotGit === null) return null;
  const line = /^gitdir:[ \t]*(.*?)[ \t]*$/m.exec(dotGit.replace(/\r/g, ''));
  if (!line || !line[1]) return null;
  let gitDir = toWslPath(line[1]);
  if (!gitDir) {
    // A repository inside WSL: `//wsl.localhost/<distro>/home/…/.git/worktrees/<name>`.
    const inWsl = taskPushGitTarget(dotGit, 'win32');
    if (inWsl.kind !== 'wsl' || (distro !== null && inWsl.distro.toLowerCase() !== distro.toLowerCase())) return null;
    gitDir = inWsl.gitDir;
  }
  return { gitDir: trimSlashes(gitDir), workTree: trimSlashes(workTree) };
}

function trimSlashes(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** The core.autocrlf value to hand on: any value Git for Windows has set,
 *  `false` included (a Linux global `true` must not convert a worktree that
 *  was checked out without conversion). Unset: nothing. Pure. */
export function autocrlfToPass(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v || null;
}

/**
 * Add the plan to a pane's (already resolved) environment: the WMUX_WSL_GIT_*
 * values and their WSLENV entries, keeping every other WSLENV entry. Mutates
 * `env`.
 */
export function applyWslWorkerGit(env: Record<string, string>, plan: WslWorkerGitPlan, autocrlf: string | null): void {
  env.WMUX_WSL_GIT_DIR = plan.gitDir;
  env.WMUX_WSL_GIT_WORK_TREE = plan.workTree;
  const entries = ['WMUX_WSL_GIT_DIR/u', 'WMUX_WSL_GIT_WORK_TREE/u'];
  const pass = autocrlfToPass(autocrlf);
  if (pass) {
    env.WMUX_WSL_GIT_AUTOCRLF = pass;
    entries.push('WMUX_WSL_GIT_AUTOCRLF/u');
  }
  env.WSLENV = mergeWslEnv(env.WSLENV, entries);
}

export interface WslWorkerGitDeps {
  readDotGit?: (cwd: string) => string | null;
  git?: (args: string[], cwd: string) => Promise<GitResult>;
}

function readDotGitFile(cwd: string): string | null {
  try {
    const p = path.join(cwd, '.git');
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * pty:create, for a fan-out task pane whose shell is WSL: add the worktree's
 * Linux git location to its environment. Best effort — a folder this cannot
 * read is left as it was. Returns whether the environment was changed.
 */
export async function withWslWorkerGit(env: Record<string, string>, cwd: string, distro: string | null, deps: WslWorkerGitDeps = {}): Promise<boolean> {
  const found = await resolveWslWorkerGit(cwd, distro, deps);
  if (!found) return false;
  applyWslWorkerGit(env, found.plan, found.autocrlf);
  return true;
}

/** The plan for `cwd` and Git for Windows' effective core.autocrlf there
 *  (system, global and local config: the one the worktree was checked out
 *  with), or null when there is nothing to fix. */
export async function resolveWslWorkerGit(cwd: string, distro: string | null, deps: WslWorkerGitDeps = {}): Promise<{ plan: WslWorkerGitPlan; autocrlf: string | null } | null> {
  const plan = wslWorkerGitPlan(cwd, (deps.readDotGit ?? readDotGitFile)(cwd), distro);
  if (!plan) return null;
  const r = await (deps.git ?? runGit)(['config', '--get', 'core.autocrlf'], cwd).catch(() => null);
  return { plan, autocrlf: r && r.code === 0 ? r.stdout : null };
}
