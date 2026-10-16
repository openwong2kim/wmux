// ─── Did a bot task make no changes? ───────────────────────────────────────
//
// The bot task gate (taskGate.ts) skips a task that made no commits beyond
// the commit its branch was created from, and the bot then settles it from
// its report; the ledger takes the bot's `completed` on that skip. Both the
// skip and that completion ask this one check, and it trusts nothing the
// worker can write:
//
//   - the base: the commit main recorded in the ledger at dispatch
//     (LedgerDispatch.baseOid), not the worktree's task.json;
//   - the worktree's HEAD: the work the report is about;
//   - what was published: main's own record of the commit task.push last
//     sent (taskPushRecord.ts), and the task branch on origin itself
//     (`ls-remote`, in the git task.push pushes with, origin checked to be
//     the task's repository) — never a remote-tracking ref in the worktree.
//
// Each must be the base or behind it (`merge-base --is-ancestor`; a commit
// the repository does not hold is not). Anything that cannot be read is
// `unknown`: the gate then runs, and a completion on the skip is refused.

import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import { readTaskRemoteHead, type TaskRemoteHeadResult } from '../worktask/taskFetch';
import { taskPushRecordOf, type TaskPushLookup } from '../worktask/taskPushRecord';
import { taskMissionFromMissions } from './verifyPreset';

export type NoChangesVerdict =
  /** No work past `base`: `head` is the worktree HEAD that was checked. */
  | { kind: 'unchanged'; base: string; head: string }
  | { kind: 'changed'; why: string }
  | { kind: 'unknown'; why: string };

type Git = (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>;
type Rpc = (method: string, params?: unknown) => Promise<unknown>;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Whether commit `commit` is `base` or an ancestor of it (it holds nothing
 * past the base), in the worktree's repository. False when that cannot be
 * told: not full commit ids, or a commit not in the repository.
 */
export async function commitWithinBase(git: Git, worktreePath: string, commit: string, base: string): Promise<boolean> {
  if (!SHA_RE.test(commit) || !SHA_RE.test(base)) return false;
  if (commit.toLowerCase() === base.toLowerCase()) return true;
  try {
    return (await git(['merge-base', '--is-ancestor', commit, base], worktreePath)).code === 0;
  } catch {
    return false;
  }
}

export interface NoChangesPorts {
  /** The task's worktree and branch (main's mission record); null when it
   *  cannot be read. */
  mission: (entry: LedgerEntry) => Promise<{ worktreePath: string; branch: string } | null>;
  /** The worktree's HEAD commit; null when it cannot be read. */
  headOf: (worktreePath: string) => Promise<string | null>;
  commitWithin: (worktreePath: string, commit: string, base: string) => Promise<boolean>;
  /** Main's record of the commit task.push last published for the task. */
  pushed: (taskId: string) => TaskPushLookup;
  /** The task branch on origin (readTaskRemoteHead). */
  remoteHead: (entry: LedgerEntry, mission: { worktreePath: string; branch: string }) => Promise<TaskRemoteHeadResult>;
}

/** Whether the task holds no work past its recorded base. Never throws. */
export async function checkNoChanges(ports: NoChangesPorts, entry: LedgerEntry): Promise<NoChangesVerdict> {
  const unknown = (why: string): NoChangesVerdict => ({ kind: 'unknown', why });
  const base = entry.dispatch?.checkout ? undefined : entry.dispatch?.baseOid;
  if (!base || !SHA_RE.test(base)) return unknown('no base commit was recorded for the task');
  try {
    const mission = await ports.mission(entry);
    if (!mission) return unknown('the task\'s worktree and branch could not be read');
    const wt = mission.worktreePath;
    const head = await ports.headOf(wt);
    if (!head) return unknown('the worktree\'s HEAD could not be read');
    if (!(await ports.commitWithin(wt, head, base))) return { kind: 'changed', why: `the worktree's HEAD ${head} holds commits past ${base}` };
    const pushed = ports.pushed(entry.id);
    if (pushed === 'unknown') return unknown('main\'s record of the task\'s pushes could not be read');
    if (pushed && !(await ports.commitWithin(wt, pushed, base))) return { kind: 'changed', why: `task_push published ${pushed}, past ${base}` };
    const remote = await ports.remoteHead(entry, mission);
    if (!remote.ok) return unknown(`origin's ${mission.branch} could not be read (${remote.error})`);
    if (remote.sha && !(await ports.commitWithin(wt, remote.sha, base))) return { kind: 'changed', why: `origin's ${mission.branch} is at ${remote.sha}, past ${base}` };
    return { kind: 'unchanged', base, head };
  } catch (err) {
    return unknown(String(err));
  }
}

/** The check over main's own records, git and origin. `botRepoKey`: a bot's
 *  repository (its profile), for a task whose dispatch names none. */
export function liveNoChangesCheck(deps: {
  rpc: () => Rpc | null;
  git: Git;
  wmuxDir: () => string;
  botRepoKey: (botId: string) => string | undefined;
}): (entry: LedgerEntry) => Promise<NoChangesVerdict> {
  const ports: NoChangesPorts = {
    mission: (entry) => taskMissionFromMissions(deps.rpc(), entry),
    headOf: async (wt) => {
      const r = await deps.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], wt);
      const sha = r.stdout.trim();
      return r.code === 0 && SHA_RE.test(sha) ? sha : null;
    },
    commitWithin: (wt, commit, base) => commitWithinBase(deps.git, wt, commit, base),
    pushed: (taskId) => taskPushRecordOf(deps.wmuxDir()).get(taskId),
    remoteHead: async (entry, mission) => {
      const origin = entry.dispatch?.origin;
      const expectedRepoKey = entry.dispatch?.repoKey ?? (origin?.kind === 'bot' && origin.botId ? deps.botRepoKey(origin.botId) : undefined);
      // A bot's task is read only from its own repository.
      if (origin?.kind === 'bot' && !expectedRepoKey) return { ok: false, reason: 'remote-refused', error: 'the task names no repository' };
      return readTaskRemoteHead({
        worktreePath: mission.worktreePath,
        branch: mission.branch,
        noHooksDir: path.join(deps.wmuxDir(), 'factory', 'no-hooks'),
        ...(expectedRepoKey ? { expectedRepoKey } : {}),
      });
    },
  };
  return (entry) => checkNoChanges(ports, entry);
}
