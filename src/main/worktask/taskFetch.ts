// ─── task.fetch — main fetches origin into a task's relay, the worker merges ─
//
// The read half of task.push (taskPush.ts). A worker whose shell has no
// credentials for origin (a WSL pane on a Windows-drive repository) cannot
// fetch, so it could neither bring the default branch into its branch to
// settle a conflict nor read it fresh. Main fetches for it, in the same git
// task.push pushes with (main's own, or the repository's WSL distro's), under
// the same config checks:
//
//   - WHICH repository: the git dir main recorded for the task (never one
//     found through the worktree); for a bot's task, origin must be a plain
//     https/ssh address of the bot's own repository.
//   - WHAT: the repository's default branch (the remote's HEAD, else GitHub's
//     by key, else origin/HEAD) and the task branch. No tag, no submodule, no
//     local branch, and the checkout is never touched.
//   - HOW: every network call (each ls-remote, the fetch) runs in the task's
//     relay (taskPush.ts openTaskGitRepo), which borrows the recorded
//     repository's objects; the fetched objects land in the relay, not the
//     recorded repository, and main writes nothing under it. task.fetch
//     returns a `git fetch` line the worker runs in its own shell to bring the
//     branches into its own `refs/remotes/origin/*`; then it merges
//     (`git merge origin/<default>`). Refused when the repository config
//     defines a remote named by origin's URL or a bundle URI.
//   - Never a push.

import { fetchCommandFor } from '../../shared/taskGitRelay';
import { toWslPath } from '../../shared/imagePaste';
import { isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import { defaultGit, openTaskGitRepo, originPinRefusal, parseLsRemoteHead, type TaskGitRepo, type TaskGitRepoInput, type TaskOriginPinInput, type TaskPushDeps, type TaskPushGit } from './taskPush';
import { originUrlRepoKey, urlNamedRemoteRefusal, workerOriginRefusal, type GitConfigEntry } from './workerGit';

export interface TaskFetchInput extends TaskGitRepoInput, TaskOriginPinInput {
  /** The task's branch (main's record). */
  branch: string;
  /** A bot's task: the repository origin must be. Absent for a task of the
   *  operator's. */
  expectedRepoKey?: string;
  /** The repository's own default branch, read by its key. */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
}

/** One fetched branch: `origin/<branch>` and its commit in the relay. */
export interface TaskFetchedRef { ref: string; sha: string }

export type TaskFetchResult =
  | {
    ok: true; remote: 'origin'; defaultBranch: string;
    /** The line the worker runs in its own shell (the repository's platform). */
    fetchCommand: string;
    /** On a Windows host: the same line for a WSL shell (the relay by its
     *  `/mnt/<drive>/…` path). */
    fetchCommandWsl?: string;
    fetched: TaskFetchedRef[]; missing: string[];
  }
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
 *  checks: a remote whose name is origin's URL, or a bundle URI. Only the
 *  repository's own scopes count. Pure. */
export function taskFetchConfigRefusal(entries: readonly GitConfigEntry[], url: string): string | null {
  const named = urlNamedRemoteRefusal(entries, url);
  if (named) return named;
  const own = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const hit = own.find((e) => /^(?:fetch|transfer)\.bundleuri$/.test(e.key) || e.key.startsWith('bundle.'));
  return hit ? `the repository's git config sets ${hit.key}, which main does not fetch with` : null;
}

/** The git argv of main's fetch into the relay: each branch into the relay's
 *  own `refs/heads/<b>`, nothing else written. Pure. */
export function taskFetchArgs(url: string, branches: readonly string[]): string[] {
  return [
    'fetch', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph',
    '--', url, ...branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`),
  ];
}

type TaskRemoteFailure = Extract<TaskFetchResult, { ok: false }>;

/** Main's git on the task's recorded repository and relay, after the push's
 *  and the fetch's config checks, and origin's URL and key. Never throws. */
async function openTaskRemote(
  input: Pick<TaskFetchInput, keyof TaskGitRepoInput | keyof TaskOriginPinInput | 'expectedRepoKey'>,
  git: TaskPushGit,
  deps: TaskPushDeps,
): Promise<{ ok: true; repo: TaskGitRepo; url: string; key: string | null } | TaskRemoteFailure> {
  const opened = await openTaskGitRepo(input, git, deps);
  if (!opened.ok) return opened;
  const { repo } = opened;
  const origin = workerOriginRefusal(repo.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const fetchRefusal = taskFetchConfigRefusal(repo.entries, origin.url);
  if (fetchRefusal) return { ok: false, reason: 'config-refused', error: fetchRefusal };
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  const pinRefusal = await originPinRefusal(origin.url, input, repo.config);
  if (pinRefusal) return { ok: false, reason: 'remote-refused', error: pinRefusal };
  return { ok: true, repo, url: origin.url, key };
}

export type TaskRemoteHeadResult = { ok: true; sha: string | null } | TaskRemoteFailure;

/**
 * The commit the task branch is at on origin itself (`ls-remote`, nothing
 * written), read in the git task.push pushes with and under the same checks:
 * null when origin has no such branch. Never throws.
 */
export async function readTaskRemoteHead(
  input: Pick<TaskFetchInput, keyof TaskGitRepoInput | keyof TaskOriginPinInput | 'branch' | 'expectedRepoKey'>,
  git: TaskPushGit = defaultGit,
  deps: TaskPushDeps = {},
): Promise<TaskRemoteHeadResult> {
  if (!isDenyableBranchName(input.branch)) return { ok: false, reason: 'branch-refused', error: 'the task branch name cannot be read as itself' };
  const remote = await openTaskRemote(input, git, deps);
  if (!remote.ok) return remote;
  const heads = await remote.repo.inRelay(remote.url, (run) => run(['ls-remote', '--heads', '--', remote.url, `refs/heads/${input.branch}`]));
  if (!heads.ok) return { ok: false, reason: 'git-failed', error: heads.error };
  if (heads.value.code !== 0) return { ok: false, reason: 'git-failed', error: `git ls-remote failed: ${heads.value.stderr.trim().slice(0, 500)}` };
  return { ok: true, sha: parseLsRemoteHeads(heads.value.stdout).get(input.branch) ?? null };
}

/** Fetch the default branch and the task branch into the relay, and return the
 *  line the worker runs to bring them into its own origin refs. Never throws. */
export async function fetchTaskRefs(input: TaskFetchInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<TaskFetchResult> {
  if (!isDenyableBranchName(input.branch)) return { ok: false, reason: 'branch-refused', error: 'the task branch name cannot be fetched as itself' };
  const opened = await openTaskRemote(input, git, deps);
  if (!opened.ok) return opened;
  const { repo, key, url } = opened;
  const lsRemote = async (args: string[]) => {
    const r = await repo.inRelay(url, (run) => run(['ls-remote', ...args]));
    return r.ok ? r.value : { code: 1, stdout: '', stderr: r.error };
  };
  // The default branch: the remote's own HEAD, else GitHub's by key, else
  // origin/HEAD.
  const remote = await lsRemote(['--symref', '--', url, 'HEAD']);
  let defaultBranch = remote.code === 0 ? parseLsRemoteHead(remote.stdout) : null;
  if (!defaultBranch && key && input.repoDefaultBranch) defaultBranch = await input.repoDefaultBranch(key).catch(() => null);
  if (!defaultBranch) {
    const ref = await repo.local(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = ref.code === 0 ? ref.stdout.trim() : '';
    if (name.startsWith('refs/remotes/origin/')) defaultBranch = name.slice('refs/remotes/origin/'.length);
  }
  if (!defaultBranch || !isDenyableBranchName(defaultBranch)) {
    return { ok: false, reason: 'no-default-branch', error: 'origin\'s default branch could not be read' };
  }
  // Only branches the remote has: a task branch not pushed yet is reported
  // missing, not an error.
  const wanted = [...new Set([defaultBranch, input.branch])];
  const heads = await lsRemote(['--heads', '--', url, ...wanted.map((b) => `refs/heads/${b}`)]);
  if (heads.code !== 0) return { ok: false, reason: 'git-failed', error: `git ls-remote failed: ${heads.stderr.trim().slice(0, 500)}` };
  const there = parseLsRemoteHeads(heads.stdout);
  if (!there.has(defaultBranch)) return { ok: false, reason: 'no-default-branch', error: `origin has no branch ${defaultBranch}` };
  const present = wanted.filter((b) => there.has(b));
  const res = await repo.inRelay(url, async (run): Promise<{ error: string } | { shas: string[] }> => {
    const f = await run(taskFetchArgs(url, present));
    if (f.code !== 0) return { error: `${f.stdout}\n${f.stderr}`.trim().slice(0, 2000) || `git fetch exited ${f.code}` };
    const shas: string[] = [];
    for (const b of present) {
      const sha = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]);
      shas.push(sha.code === 0 ? sha.stdout.trim() : '');
    }
    return { shas };
  });
  if (!res.ok) return { ok: false, reason: 'git-failed', error: res.error };
  if ('error' in res.value) return { ok: false, reason: 'git-failed', error: res.value.error };
  const { shas } = res.value;
  const fetched: TaskFetchedRef[] = [];
  for (const [i, b] of present.entries()) {
    const sha = shas[i] ?? '';
    if (!sha) return { ok: false, reason: 'git-failed', error: `origin/${b} could not be read in the relay after the fetch` };
    fetched.push({ ref: `origin/${b}`, sha });
  }
  const refspecs = present.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  const fetchCommand = fetchCommandFor(repo.relayShellPath, refspecs, repo.workerShellPlatform);
  if (!fetchCommand) return { ok: false, reason: 'git-failed', error: `main's relay path ${repo.relayShellPath} cannot be written as a shell word` };
  // A WSL pane on a Windows-drive repository reads the relay by its drvfs path.
  const wslRelay = repo.workerShellPlatform === 'win32' ? toWslPath(repo.relayShellPath) : null;
  const fetchCommandWsl = wslRelay ? fetchCommandFor(wslRelay, refspecs, 'linux') : null;
  return {
    ok: true, remote: 'origin', defaultBranch, fetchCommand,
    ...(fetchCommandWsl ? { fetchCommandWsl } : {}),
    fetched, missing: wanted.filter((b) => !there.has(b)).map((b) => `origin/${b}`),
  };
}
