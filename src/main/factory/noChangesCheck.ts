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
//   - the worktree's HEAD and the task branch's local ref (a worker that
//     committed on the branch and detached HEAD at the base still holds
//     that commit), read again as the last step, after origin answered;
//   - what was published: main's own record of the commit task.push last
//     sent (taskPushRecord.ts; `unknown` while a push is under way), and the
//     task branch on origin itself (`ls-remote`, in the git task.push
//     pushes with, origin checked to be the task's repository) — never a
//     remote-tracking ref in the worktree.
//
// Each must BE the base (an absent push or remote branch is fine). Not "at
// or behind it": that would be a `merge-base --is-ancestor` over the
// worker's own object store, whose parent links a worker can rewrite
// (replace refs, grafts, a commit-graph file, a planted object), so an
// equality of commit ids is the only answer that needs nothing from it. A
// worker that reset behind the base is gated, as any changed task is.
// Anything that cannot be read is `unknown`: the gate then runs, and a
// completion on the skip is refused.
//
// Other local refs are not read: a shared repository holds other tasks'
// and the owner's branches, and nothing main does publishes a task's local
// refs. The one way a bot task's commits leave the machine is task.push
// (the worktree's HEAD, to the task branch), and it refuses a task whose
// report stands checked as unchanged, or that was completed on that check
// (taskPush.rpc.ts), so a commit made after the last read here stays local.

import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import { isPlainTaskBranchName } from '../../shared/taskGitRelay';
import { readTaskRemoteHead, type TaskRemoteHeadResult } from '../worktask/taskFetch';
import { recordedTaskGitCommonDir, recordedTaskGitWorktreeDir } from '../worktask/taskGitCommonDir';
import { defaultGit, openTaskGitRepo, type TaskGitRepo, type TaskPushDeps, type TaskPushGit } from '../worktask/taskPush';
import { taskPushRecordOf, type TaskPushLookup } from '../worktask/taskPushRecord';
import { taskMissionFromMissions } from './verifyPreset';

export type NoChangesVerdict =
  /** No work past `base`: `head` is the worktree HEAD that was checked (it
   *  is `base`). */
  | { kind: 'unchanged'; base: string; head: string }
  | { kind: 'changed'; why: string }
  | { kind: 'unknown'; why: string };

type Rpc = (method: string, params?: unknown) => Promise<unknown>;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface NoChangesPorts {
  /** The task's worktree and branch (main's mission record); null when it
   *  cannot be read. */
  mission: (entry: LedgerEntry) => Promise<{ worktreePath: string; branch: string } | null>;
  /** The worktree's HEAD commit; null when it cannot be read. */
  headOf: (worktreePath: string, entry: LedgerEntry) => Promise<string | null>;
  /** The task branch's local ref (`refs/heads/<branch>` in the task's
   *  repository): its commit, null when there is no such ref, `unknown`
   *  when it cannot be read. */
  branchRef: (worktreePath: string, branch: string, entry: LedgerEntry) => Promise<string | null | 'unknown'>;
  /** Main's record of the commit task.push last published for the task. */
  pushed: (taskId: string) => TaskPushLookup;
  /** The task branch on origin (readTaskRemoteHead). */
  remoteHead: (entry: LedgerEntry, mission: { worktreePath: string; branch: string }) => Promise<TaskRemoteHeadResult>;
}

/** Whether the task holds no work past its recorded base. Never throws.
 *
 *  The local reads (HEAD, the task branch's ref, main's push record) are
 *  taken before origin is read and again after it, as the last step: a
 *  commit or a push made while origin answered is a change. The task
 *  branch's ref counts as much as HEAD: a worker that committed on the
 *  branch and then detached HEAD at the base still holds that commit. */
export async function checkNoChanges(ports: NoChangesPorts, entry: LedgerEntry): Promise<NoChangesVerdict> {
  const unknown = (why: string): NoChangesVerdict => ({ kind: 'unknown', why });
  const base = entry.dispatch?.checkout ? undefined : entry.dispatch?.baseOid;
  if (!base || !SHA_RE.test(base)) return unknown('no base commit was recorded for the task');
  try {
    const mission = await ports.mission(entry);
    if (!mission) return unknown('the task\'s worktree and branch could not be read');
    /** HEAD, the branch ref and the push record: each the base (or none). */
    const local = async (when: string): Promise<NoChangesVerdict | null> => {
      const head = await ports.headOf(mission.worktreePath, entry);
      if (!head || !SHA_RE.test(head)) return unknown(`the worktree's HEAD could not be read${when}`);
      if (!same(head, base)) return { kind: 'changed', why: `the worktree's HEAD is ${head}, not ${base}${when}` };
      const ref = await ports.branchRef(mission.worktreePath, mission.branch, entry);
      if (ref === 'unknown' || (ref !== null && !SHA_RE.test(ref))) return unknown(`the task branch ${mission.branch} could not be read${when}`);
      if (ref !== null && !same(ref, base)) return { kind: 'changed', why: `the task branch ${mission.branch} is at ${ref}, not ${base}${when}` };
      const pushed = ports.pushed(entry.id);
      if (pushed === 'unknown') return unknown(`main's record of the task's pushes could not be read, or a push is under way${when}`);
      if (pushed && !same(pushed, base)) return { kind: 'changed', why: `task_push published ${pushed}, not ${base}${when}` };
      return null;
    };
    const before = await local('');
    if (before) return before;
    const remote = await ports.remoteHead(entry, mission);
    if (!remote.ok) return unknown(`origin's ${mission.branch} could not be read (${remote.error})`);
    if (remote.sha && !same(remote.sha, base)) return { kind: 'changed', why: `origin's ${mission.branch} is at ${remote.sha}, not ${base}` };
    // Last: nothing moved while origin answered.
    const after = await local(' (after origin was read)');
    if (after) return after;
    return { kind: 'unchanged', base, head: base };
  } catch (err) {
    return unknown(String(err));
  }
}

export interface LiveNoChangesDeps {
  rpc: () => Rpc | null;
  /** Main's git for the task's repository (default: taskPush's). */
  git?: TaskPushGit;
  /** Test seam: the transports a network call may use. */
  gitDeps?: TaskPushDeps;
  wmuxDir: () => string;
  /** A bot's repository (its profile), for a task whose dispatch names none. */
  botRepoKey: (botId: string) => string | undefined;
  /** A bot's repository folder (its profile), for a task whose dispatch
   *  records no git dir. */
  botRepoPath?: (botId: string) => string | undefined;
  /** A bot's origin pin (its profile), for a task whose dispatch records
   *  none. */
  botOriginPin?: (botId: string) => string | undefined;
  /** Records origin's pin on a task row that has none (TaskLedger
   *  recordOriginPin); absent = such a row is read unpinned. */
  recordOriginPin?: (taskId: string, pin: string) => Promise<string | null>;
}

/** The check over main's own records, git and origin. */
export function liveNoChangesCheck(deps: LiveNoChangesDeps): (entry: LedgerEntry) => Promise<NoChangesVerdict> {
  const ports = liveNoChangesPorts(deps);
  return (entry) => checkNoChanges(ports, entry);
}

/** The ports liveNoChangesCheck reads through. */
export function liveNoChangesPorts(deps: LiveNoChangesDeps): NoChangesPorts {
  const git = deps.git ?? defaultGit;
  /** Main's git on the repository and worktree git dir main recorded for the
   *  task (never ones found through the worktree), opened anew for each read:
   *  the same checks as task_push (a partial clone is refused) run before
   *  anything is read. */
  const open = async (wt: string, entry: LedgerEntry): Promise<TaskGitRepo | null> => {
    const gitCommonDir = await recordedTaskGitCommonDir(entry.dispatch, deps.botRepoPath ?? (() => undefined));
    if (!gitCommonDir) return null;
    const gitWorktreeDir = await recordedTaskGitWorktreeDir(entry.dispatch, gitCommonDir, wt);
    const opened = await openTaskGitRepo({
      worktreePath: wt,
      gitCommonDir,
      ...(gitWorktreeDir ? { gitWorktreeDir } : {}),
      noHooksDir: path.join(deps.wmuxDir(), 'factory', 'no-hooks'),
      relayRoot: path.join(deps.wmuxDir(), 'factory', 'git-relay'),
      taskId: entry.id,
    }, git, deps.gitDeps);
    return opened.ok ? opened.repo : null;
  };
  return {
    mission: (entry) => taskMissionFromMissions(deps.rpc(), entry),
    headOf: async (wt, entry) => {
      // The HEAD file of the recorded worktree git dir, read strictly; a
      // branch resolved in the recorded refs, no object read.
      const repo = await open(wt, entry);
      const head = repo ? await repo.headOid() : null;
      return head?.ok ? head.oid : null;
    },
    branchRef: async (wt, branch, entry) => {
      // The ref's value as stored, in the repository main recorded for the
      // task.
      if (!isPlainTaskBranchName(branch)) return 'unknown';
      const repo = await open(wt, entry);
      if (!repo) return 'unknown';
      const r = await repo.local(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}`]);
      const sha = r.stdout.trim();
      if (r.code === 0 && SHA_RE.test(sha)) return sha;
      // `--verify --quiet` exits 1, printing nothing, for a ref that is not there.
      return r.code === 1 && !sha ? null : 'unknown';
    },
    pushed: (taskId) => taskPushRecordOf(deps.wmuxDir()).get(taskId),
    remoteHead: async (entry, mission) => {
      const origin = entry.dispatch?.origin;
      const expectedRepoKey = entry.dispatch?.repoKey ?? (origin?.kind === 'bot' && origin.botId ? deps.botRepoKey(origin.botId) : undefined);
      // A bot's task is read only from its own repository.
      if (origin?.kind === 'bot' && !expectedRepoKey) return { ok: false, reason: 'remote-refused', error: 'the task names no repository' };
      // Read in the repository main recorded, never one found through the worktree.
      const gitCommonDir = await recordedTaskGitCommonDir(entry.dispatch, deps.botRepoPath ?? (() => undefined));
      if (!gitCommonDir) return { ok: false, reason: 'git-failed', error: 'wmux recorded no repository folder for the task' };
      // origin's exact address: the dispatch's pin, else the bot's profile's;
      // a row with neither is pinned at this first use.
      const expectedOriginPin = entry.dispatch?.originPin ?? (origin?.kind === 'bot' && origin.botId ? deps.botOriginPin?.(origin.botId) : undefined);
      const record = deps.recordOriginPin;
      return readTaskRemoteHead({
        worktreePath: mission.worktreePath,
        branch: mission.branch,
        noHooksDir: path.join(deps.wmuxDir(), 'factory', 'no-hooks'),
        gitCommonDir,
        relayRoot: path.join(deps.wmuxDir(), 'factory', 'git-relay'),
        taskId: entry.id,
        ...(expectedRepoKey ? { expectedRepoKey } : {}),
        ...(expectedOriginPin ? { expectedOriginPin } : record ? { recordOriginPin: (p: string) => record(entry.id, p) } : {}),
      }, git, deps.gitDeps);
    },
  };
}
