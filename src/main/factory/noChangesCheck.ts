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

import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import { readTaskRemoteHead, type TaskRemoteHeadResult } from '../worktask/taskFetch';
import { taskPushRecordOf, type TaskPushLookup } from '../worktask/taskPushRecord';
import { taskMissionFromMissions } from './verifyPreset';

export type NoChangesVerdict =
  /** No work past `base`: `head` is the worktree HEAD that was checked (it
   *  is `base`). */
  | { kind: 'unchanged'; base: string; head: string }
  | { kind: 'changed'; why: string }
  | { kind: 'unknown'; why: string };

type Git = (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>;
type Rpc = (method: string, params?: unknown) => Promise<unknown>;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface NoChangesPorts {
  /** The task's worktree and branch (main's mission record); null when it
   *  cannot be read. */
  mission: (entry: LedgerEntry) => Promise<{ worktreePath: string; branch: string } | null>;
  /** The worktree's HEAD commit; null when it cannot be read. */
  headOf: (worktreePath: string) => Promise<string | null>;
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
    const head = await ports.headOf(mission.worktreePath);
    if (!head || !SHA_RE.test(head)) return unknown('the worktree\'s HEAD could not be read');
    if (!same(head, base)) return { kind: 'changed', why: `the worktree's HEAD is ${head}, not ${base}` };
    const pushed = ports.pushed(entry.id);
    if (pushed === 'unknown') return unknown('main\'s record of the task\'s pushes could not be read, or a push is under way');
    if (pushed && !same(pushed, base)) return { kind: 'changed', why: `task_push published ${pushed}, not ${base}` };
    const remote = await ports.remoteHead(entry, mission);
    if (!remote.ok) return unknown(`origin's ${mission.branch} could not be read (${remote.error})`);
    if (remote.sha && !same(remote.sha, base)) return { kind: 'changed', why: `origin's ${mission.branch} is at ${remote.sha}, not ${base}` };
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
      // The ref's own commit id: no replace ref stands in for it.
      const r = await deps.git(['--no-replace-objects', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], wt);
      const sha = r.stdout.trim();
      return r.code === 0 && SHA_RE.test(sha) ? sha : null;
    },
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
