/**
 * Removing a phone-created worktree from the desktop cleanup list (contract
 * item 5, "desktop cleanup"). A phone worktree has no task, so the task close
 * flow cannot reclaim it; this is its path-based counterpart.
 *
 * The path comes from the renderer, so it is checked against the one shape
 * the daemon creates — `{wmux home}/worktrees/<12 hex>/phone-<slug>` — with
 * every component a real directory (no link, no junction) and the realpath
 * equal to the path walked. A pane still running inside it refuses; a
 * worktree with changes, or a leftover directory git does not know, needs the
 * caller's explicit `force` (the UI asks first). The branch is deleted only in
 * a separate, confirmed call, and only a `phone/<slug>` branch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { getExecEnv } from '../../shared/execEnv';
import { PHONE_WORKTREE_BRANCH_PREFIX, PHONE_WORKTREE_DIR_PREFIX, PHONE_WORKTREE_SLUG } from '../../shared/phoneGitV1';

export type PhoneWorktreeRemoveResult =
  | { ok: true; branch?: string; repo?: string }
  | { ok: false; reason: 'invalid' | 'in-use' | 'held' | 'dirty' | 'unregistered' | 'error'; error?: string };

export type PhoneGit = (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface PhoneWorktreeRemoveDeps {
  /** `{wmux home}/worktrees`. */
  root: string;
  /** The working directories of every live pane (spawn and current). */
  livePaneCwds: () => Promise<string[]>;
  git?: PhoneGit;
  /** Whether the directory may be deleted now. Defaults to `windowsDirectoryHold` on Windows, `free` elsewhere. */
  directoryHold?: (dir: string) => Promise<DirectoryHold>;
}

/** `in-use`: a process holds the directory itself. `refused`: a handle below it, or an ACL. */
export type DirectoryHold = 'free' | 'in-use' | 'refused';

const defaultGit: PhoneGit = (args, cwd) => new Promise((resolve) => {
  execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args],
    { cwd, timeout: 60_000, windowsHide: true, env: { ...getExecEnv(), GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

const canonical = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/**
 * Windows: anything that stops the directory itself from being deleted makes
 * `git worktree remove` delete every file and then fail on the directory. A
 * rename to the same path opens the directory for DELETE and, when that
 * succeeds, changes nothing (no timestamp, attribute, ACL or change
 * notification). When it fails:
 * - EBUSY: a process holds the directory itself, e.g. a shell whose current
 *   directory it is; a cmd.exe prompt is not scraped, so that pane's cwd is
 *   never reported;
 * - EPERM / EACCES: a handle below it (a shell in a subdirectory, a file some
 *   program has open) or an ACL that forbids deleting it.
 * Anything else (ENOENT: already gone) is no hold, and the removal proceeds.
 */
export async function windowsDirectoryHold(dir: string): Promise<DirectoryHold> {
  try {
    await fs.promises.rename(dir, dir);
    return 'free';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EBUSY' ? 'in-use' : code === 'EPERM' || code === 'EACCES' ? 'refused' : 'free';
  }
}

const defaultDirectoryHold = async (dir: string): Promise<DirectoryHold> =>
  process.platform === 'win32' ? windowsDirectoryHold(dir) : 'free';

const BRANCH =new RegExp(`^${PHONE_WORKTREE_BRANCH_PREFIX}${PHONE_WORKTREE_SLUG.source.slice(1)}`);

/** The canonical phone worktree directory, or null when `worktreePath` is not one. */
export function phoneWorktreeDir(root: string, worktreePath: string): string | null {
  let rootReal: string;
  try { rootReal = fs.realpathSync.native(root); } catch { return null; }
  // The root as configured or as resolved (a home reached through a link).
  const base = [path.resolve(root), rootReal].find((b) => {
    const rel = path.relative(b, path.resolve(worktreePath));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!base) return null;
  const parts = path.relative(base, path.resolve(worktreePath)).split(path.sep);
  if (parts.length !== 2 || !/^[a-f0-9]{12}$/.test(parts[0]) || !parts[1].startsWith(PHONE_WORKTREE_DIR_PREFIX) ||
      !PHONE_WORKTREE_SLUG.test(parts[1].slice(PHONE_WORKTREE_DIR_PREFIX.length))) return null;
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    } catch { return null; }
  }
  const dir = path.join(rootReal, ...parts);
  return canonical(current) === dir ? dir : null;
}

export async function removePhoneWorktree(worktreePath: string, force: boolean, deps: PhoneWorktreeRemoveDeps): Promise<PhoneWorktreeRemoveResult> {
  const git = deps.git ?? defaultGit;
  const dir = phoneWorktreeDir(deps.root, worktreePath);
  if (!dir) return { ok: false, reason: 'invalid' };
  const inUse = (await deps.livePaneCwds()).some((cwd) => {
    const real = canonical(cwd);
    return real === dir || real.startsWith(dir + path.sep);
  });
  if (inUse) return { ok: false, reason: 'in-use' };
  const hold = await (deps.directoryHold ?? defaultDirectoryHold)(dir);
  if (hold === 'in-use') return { ok: false, reason: 'in-use' };
  // A handle below the directory and a missing delete permission look the same from here.
  if (hold === 'refused') return { ok: false, reason: 'held' };

  const top = await git(['rev-parse', '--show-toplevel'], dir);
  const registered = top.ok && canonical(top.stdout.trim()) === dir;
  if (!registered) {
    // A directory git does not know (a half-written checkout): only on request.
    if (!force) return { ok: false, reason: 'unregistered' };
    try { await fs.promises.rm(dir, { recursive: true }); } catch (e) { return { ok: false, reason: 'error', error: String(e) }; }
    return { ok: true };
  }
  const common = await git(['rev-parse', '--git-common-dir'], dir);
  if (!common.ok) return { ok: false, reason: 'error', error: common.stderr.trim() };
  const repo = path.resolve(dir, common.stdout.trim());
  const head = await git(['symbolic-ref', '-q', '--short', 'HEAD'], dir);
  const branch = head.ok && BRANCH.test(head.stdout.trim()) ? head.stdout.trim() : undefined;
  if (!force) {
    const status = await git(['status', '--porcelain', '--untracked-files=all'], dir);
    if (!status.ok) return { ok: false, reason: 'error', error: status.stderr.trim() };
    if (status.stdout.trim()) return { ok: false, reason: 'dirty' };
  } else {
    await git(['worktree', 'unlock', '--', dir], repo);
  }
  const removed = await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', dir], repo);
  if (!removed.ok) {
    return /modified or untracked/.test(removed.stderr) ? { ok: false, reason: 'dirty' } : { ok: false, reason: 'error', error: removed.stderr.trim() };
  }
  return { ok: true, ...(branch ? { branch, repo } : {}) };
}

/** Delete a `phone/<slug>` branch after the user confirmed it. Git refuses a branch still checked out. */
export async function deletePhoneBranch(repo: string, branch: string, git: PhoneGit = defaultGit): Promise<{ ok: boolean; error?: string }> {
  if (!BRANCH.test(branch)) return { ok: false, error: 'not a phone branch' };
  const gitDir = await git(['rev-parse', '--git-dir'], repo);
  if (!gitDir.ok) return { ok: false, error: 'not a repository' };
  const deleted = await git(['branch', '-D', branch], repo);
  return deleted.ok ? { ok: true } : { ok: false, error: deleted.stderr.trim() };
}
