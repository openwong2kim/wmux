// ─── task.fetch — main fetches origin into a worker's task repository ───────
//
// The read half of task.push (taskPush.ts). A worker whose shell has no
// credentials for origin (a WSL pane on a Windows-drive repository) cannot
// fetch, so it could neither bring the default branch into its branch to
// settle a conflict nor read it fresh. Main fetches for it, in the same git
// task.push would push with (main's own, or the repository's WSL distro's),
// under the same config checks:
//
//   - WHICH repository: the task's worktree, from main's task record; for a
//     bot's task, origin must be a plain https/ssh address of the bot's own
//     repository.
//   - WHAT: the repository's default branch (the remote's HEAD, else GitHub's
//     by key, else origin/HEAD) and the task branch, each into its own
//     remote-tracking ref (refs/remotes/origin/<name>). No tag, no submodule,
//     no local branch, and the checkout is never touched: the worker merges
//     itself (`git merge origin/<default>`).
//   - HOW: fetched into a namespace of main's own (refs/wmux/fetch/<nonce>/)
//     with no FETCH_HEAD, no auto maintenance and no commit-graph write, then
//     set as the remote-tracking ref itself (`update-ref --no-deref`, so a
//     symbolic ref there is replaced, never followed) and the namespace
//     dropped. Refused when the repository config defines a remote named by
//     origin's URL (git would read the URL as that remote) or a bundle URI.
//   - Never a push.

import crypto from 'node:crypto';
import path from 'node:path';
import { isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import { defaultGit, parseLsRemoteHead, readDotGitFile, taskPushGitTarget, wslTaskPushGit, type TaskPushDeps, type TaskPushGit } from './taskPush';
import { originUrlRepoKey, workerGitPreflight, workerGitSafeArgs, workerOriginRefusal, type GitConfigEntry } from './workerGit';

export interface TaskFetchInput {
  /** The task's worktree (main's record). */
  worktreePath: string;
  /** The task's branch (main's record). */
  branch: string;
  /** An empty folder for `core.hooksPath`. */
  noHooksDir: string;
  /** A bot's task: the repository origin must be. Absent for a task of the
   *  operator's. */
  expectedRepoKey?: string;
  /** The repository's own default branch, read by its key. */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
}

/** One fetched remote-tracking ref: `origin/<branch>` and its commit. */
export interface TaskFetchedRef { ref: string; sha: string }

export type TaskFetchResult =
  | { ok: true; remote: 'origin'; defaultBranch: string; fetched: TaskFetchedRef[]; missing: string[] }
  | { ok: false; reason: 'branch-refused' | 'no-origin' | 'remote-refused' | 'config-refused' | 'no-default-branch' | 'git-failed'; error: string };

/** `ls-remote --heads` output → branch name → commit. Pure. */
export function parseLsRemoteHeads(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const m = /^([0-9a-f]{40,64})\trefs\/heads\/(\S+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** Why main will not fetch with this repository config, beyond the push's
 *  checks: a remote whose name is origin's URL (git would take the URL for
 *  that remote, with its own URL and refspecs), or a bundle URI (fetched
 *  from wherever it names). Only the repository's own scopes count. Pure. */
export function taskFetchConfigRefusal(entries: readonly GitConfigEntry[], url: string): string | null {
  const own = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const asRemote = `remote.${url.toLowerCase()}.`;
  const hit = own.find((e) => e.key.startsWith(asRemote) || /^(?:fetch|transfer)\.bundleuri$/.test(e.key) || e.key.startsWith('bundle.'));
  return hit ? `the repository's git config sets ${hit.key}, which main does not fetch with` : null;
}

/** The git argv of main's fetch: each branch into main's own namespace
 *  (`<ns>/<i>`), nothing else written. Pure. */
export function taskFetchArgs(url: string, branches: readonly string[], ns: string): string[] {
  return [
    'fetch', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph',
    '--', url, ...branches.map((b, i) => `+refs/heads/${b}:${ns}/${i}`),
  ];
}

type TaskRemoteFailure = Extract<TaskFetchResult, { ok: false }>;

/** The git main reads origin with for a task (main's own, or the
 *  repository's WSL distro's), after the push's and the fetch's config
 *  checks, and origin's URL and key. Never throws. */
async function openTaskRemote(
  input: Pick<TaskFetchInput, 'worktreePath' | 'noHooksDir' | 'expectedRepoKey'>,
  git: TaskPushGit,
  deps: TaskPushDeps,
): Promise<{ ok: true; run: (args: string[]) => ReturnType<TaskPushGit>; url: string; key: string | null } | TaskRemoteFailure> {
  const platform = deps.platform ?? process.platform;
  const target = taskPushGitTarget(platform === 'win32' ? (deps.readDotGit ?? readDotGitFile)(input.worktreePath) : null, platform);
  if (target.kind === 'refused') return { ok: false, reason: 'git-failed', error: target.error };
  const safe = workerGitSafeArgs(target.kind === 'wsl' ? '/dev/null' : path.resolve(input.noHooksDir));
  const runner = target.kind === 'wsl' ? wslTaskPushGit(target.distro, target.gitDir, deps.wslExec) : git;
  const run = (args: string[]) => runner([...safe, ...args], input.worktreePath);
  const pre = await workerGitPreflight(run);
  if (!pre.ok) return { ok: false, reason: 'config-refused', error: pre.error };
  const origin = workerOriginRefusal(pre.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const fetchRefusal = taskFetchConfigRefusal(pre.entries, origin.url);
  if (fetchRefusal) return { ok: false, reason: 'config-refused', error: fetchRefusal };
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  return { ok: true, run, url: origin.url, key };
}

export type TaskRemoteHeadResult = { ok: true; sha: string | null } | TaskRemoteFailure;

/**
 * The commit the task branch is at on origin itself (`ls-remote`, nothing
 * written), read in the git task.push pushes with and under the same checks:
 * null when origin has no such branch. The task's repository and branch
 * come from main's record; for a bot's task origin must be its repository.
 * Never throws.
 */
export async function readTaskRemoteHead(
  input: Pick<TaskFetchInput, 'worktreePath' | 'branch' | 'noHooksDir' | 'expectedRepoKey'>,
  git: TaskPushGit = defaultGit,
  deps: TaskPushDeps = {},
): Promise<TaskRemoteHeadResult> {
  if (!isDenyableBranchName(input.branch)) return { ok: false, reason: 'branch-refused', error: 'the task branch name cannot be read as itself' };
  const remote = await openTaskRemote(input, git, deps);
  if (!remote.ok) return remote;
  const heads = await remote.run(['ls-remote', '--heads', '--', remote.url, `refs/heads/${input.branch}`]);
  if (heads.code !== 0) return { ok: false, reason: 'git-failed', error: `git ls-remote failed: ${heads.stderr.trim().slice(0, 500)}` };
  return { ok: true, sha: parseLsRemoteHeads(heads.stdout).get(input.branch) ?? null };
}

/** Fetch the default branch and the task branch. Never throws. */
export async function fetchTaskRefs(input: TaskFetchInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<TaskFetchResult> {
  if (!isDenyableBranchName(input.branch)) return { ok: false, reason: 'branch-refused', error: 'the task branch name cannot be fetched as itself' };
  const opened = await openTaskRemote(input, git, deps);
  if (!opened.ok) return opened;
  const { run, key } = opened;
  const origin = { url: opened.url };
  // The default branch: the remote's own HEAD, else GitHub's by key, else
  // origin/HEAD.
  const remote = await run(['ls-remote', '--symref', '--', origin.url, 'HEAD']);
  let defaultBranch = remote.code === 0 ? parseLsRemoteHead(remote.stdout) : null;
  if (!defaultBranch && key && input.repoDefaultBranch) defaultBranch = await input.repoDefaultBranch(key).catch(() => null);
  if (!defaultBranch) {
    const ref = await run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = ref.code === 0 ? ref.stdout.trim() : '';
    if (name.startsWith('refs/remotes/origin/')) defaultBranch = name.slice('refs/remotes/origin/'.length);
  }
  if (!defaultBranch || !isDenyableBranchName(defaultBranch)) {
    return { ok: false, reason: 'no-default-branch', error: 'origin\'s default branch could not be read' };
  }
  // Only branches the remote has: a task branch not pushed yet is reported
  // missing, not an error.
  const wanted = [...new Set([defaultBranch, input.branch])];
  const heads = await run(['ls-remote', '--heads', '--', origin.url, ...wanted.map((b) => `refs/heads/${b}`)]);
  if (heads.code !== 0) return { ok: false, reason: 'git-failed', error: `git ls-remote failed: ${heads.stderr.trim().slice(0, 500)}` };
  const there = parseLsRemoteHeads(heads.stdout);
  if (!there.has(defaultBranch)) return { ok: false, reason: 'no-default-branch', error: `origin has no branch ${defaultBranch}` };
  const present = wanted.filter((b) => there.has(b));
  const ns = `refs/wmux/fetch/${crypto.randomBytes(8).toString('hex')}`;
  const drop = async (): Promise<void> => {
    for (let i = 0; i < present.length; i++) await run(['update-ref', '--no-deref', '-d', `${ns}/${i}`]);
  };
  const res = await run(taskFetchArgs(origin.url, present, ns));
  if (res.code !== 0) {
    await drop();
    return { ok: false, reason: 'git-failed', error: `${res.stdout}\n${res.stderr}`.trim().slice(0, 2000) || `git fetch exited ${res.code}` };
  }
  const fetched: TaskFetchedRef[] = [];
  for (const [i, b] of present.entries()) {
    const sha = await run(['rev-parse', '--verify', '--quiet', `${ns}/${i}^{commit}`]);
    const commit = sha.code === 0 ? sha.stdout.trim() : '';
    // The remote-tracking ref itself, never what a symbolic ref there names.
    const set = commit ? await run(['update-ref', '--no-deref', '-m', 'wmux task_fetch', `refs/remotes/origin/${b}`, commit]) : null;
    if (!set || set.code !== 0) {
      await drop();
      return { ok: false, reason: 'git-failed', error: `origin/${b} could not be set after the fetch${set ? `: ${set.stderr.trim().slice(0, 300)}` : ''}` };
    }
    fetched.push({ ref: `origin/${b}`, sha: commit });
  }
  await drop();
  return { ok: true, remote: 'origin', defaultBranch, fetched, missing: wanted.filter((b) => !there.has(b)).map((b) => `origin/${b}`) };
}
