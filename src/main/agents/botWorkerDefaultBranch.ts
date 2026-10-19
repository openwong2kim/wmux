// ─── A bot repository's default branch, for main's push of its workers ─────
//
// Before a bot's workers launch in a repository, main reads that repository's
// default branch — GitHub's own (`gh repo view --json defaultBranchRef`),
// else origin/HEAD — and records it in factory/worker-default-branches.json:
// main's push of a worker's branch (`task.push`, worktask/taskPush.ts) never
// lands on one.
// main and master are always covered; a read that fails leaves just those.
// A branch read but not recordable refuses the launch. One successful read
// per repository per DEFAULT_BRANCH_TTL_MS.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { getWmuxDir } from '../../daemon/config';
import { getExecEnv } from '../../shared/execEnv';
import { isDenyableBranchName, recordBotWorkerDefaultBranch } from '../../shared/botWorkerGuard';

const execFileP = promisify(execFile);

export const DEFAULT_BRANCH_TTL_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 8_000;

export interface DefaultBranchDeps {
  /** Runs `gh` or `git` in `cwd`; stdout. */
  run?: (cmd: 'gh' | 'git', args: string[], cwd: string) => Promise<string>;
  dir?: string;
  now?: () => number;
}

const read = new Map<string, { name: string; at: number }>();

async function defaultRun(cmd: 'gh' | 'git', args: string[], cwd: string): Promise<string> {
  const env = { ...getExecEnv(), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
  const { stdout } = await execFileP(cmd, args, { cwd, env, timeout: READ_TIMEOUT_MS, windowsHide: true });
  return String(stdout);
}

/** The repository's default branch name as GitHub (else origin/HEAD) names
 *  it, or null when neither tells it. The name is returned as read: whether
 *  it can become a rule is the recorder's check. */
export async function readRepoDefaultBranch(repoRoot: string, deps: DefaultBranchDeps = {}): Promise<string | null> {
  const run = deps.run ?? defaultRun;
  try {
    const name = (await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], repoRoot)).trim();
    if (name) return name;
  } catch {
    /* no gh, not signed in, or offline: origin/HEAD */
  }
  try {
    const ref = (await run('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot)).trim();
    const name = ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : '';
    if (name) return name;
  } catch {
    /* origin/HEAD unset */
  }
  return null;
}

/** A repository's default branch as GitHub names it, by its `host/owner/repo`
 *  key: read without a working folder, so no repository config is involved.
 *  null when gh cannot tell. */
export async function readRepoDefaultBranchByKey(repoKey: string, deps: DefaultBranchDeps = {}): Promise<string | null> {
  // A GitLab subgroup project is no GitHub repository.
  if (repoKey.split('/').length !== 3) return null;
  const run = deps.run ?? defaultRun;
  try {
    const name = (await run('gh', ['repo', 'view', repoKey, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], os.tmpdir())).trim();
    return name || null;
  } catch {
    return null;
  }
}

/** What a launch learned: the default branch (null: unread, so main and
 *  master only), and whether it is recorded for main's push. */
export interface DefaultBranchNote { name: string | null; recorded: boolean }

/** Read (or reuse) the repository's default branch and record it for
 *  main's push. Never throws. A name read but not recorded (one no rule
 *  can hold, or a failed write) is `recorded: false`: the caller does not
 *  launch. Only a successful read is reused. */
export async function noteBotRepoDefaultBranch(repoRoot: string, deps: DefaultBranchDeps = {}): Promise<DefaultBranchNote> {
  const now = (deps.now ?? Date.now)();
  const hit = read.get(repoRoot);
  let name: string | null;
  if (hit && now - hit.at < DEFAULT_BRANCH_TTL_MS) {
    name = hit.name;
  } else {
    name = await readRepoDefaultBranch(repoRoot, deps).catch(() => null);
    if (name) read.set(repoRoot, { name, at: now });
    else read.delete(repoRoot);
  }
  if (!name) return { name: null, recorded: false };
  // Recorded on every launch, so a file that lost it gets it back first.
  const recorded = isDenyableBranchName(name) && recordBotWorkerDefaultBranch(deps.dir ?? getWmuxDir(), name);
  if (!recorded) console.warn(`[factory] ${repoRoot}'s default branch cannot be recorded for main's push`);
  return { name, recorded };
}

/** Why a bot's workers may not launch in this repository, or null. */
export function defaultBranchRefusal(note: DefaultBranchNote): string | null {
  return note.name && !note.recorded
    ? `the repository's default branch (${note.name.slice(0, 80)}) cannot be kept from its workers' pushes`
    : null;
}

/** Tests: forget what was read. */
export function resetDefaultBranchReadsForTests(): void {
  read.clear();
}
