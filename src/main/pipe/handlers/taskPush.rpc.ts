// ─── task.push — a fan-out worker publishes its own task branch ─────────────
//
// What is trusted, and from where:
//   - WHO: the caller's senderPtyId, which the wmux MCP server fills from its
//     own process-tree walk to the pane it runs under (not a field the model
//     writes); main resolves it to the pane's task workspace.
//   - WHICH task: that workspace's open ledger row, and the WorkTask main
//     created for it (worktree, branch). The wire names neither.
//   - WHERE: a bot's task goes only to the bot's own repository (its profile,
//     set by the owner); an operator's task to the operator's origin.
//   - HOW: the task's own branch, fast-forward only, never a default branch,
//     under the config checks of main/worktask/taskPush.ts.
//
// Refused for a commander (brain) or a bot token — they own tasks, they are
// not a task's worker — and for a task on a detached checkout (verify).
//
// A bot's worker resumed after its task ended (to settle a conflict, say)
// has no open task: the exact pane recorded for that resumed worker
// (factory/workerReclaim.ts) stands for its own task, that task only, while
// the task still has its worktree branch.
//
// task.fetch — the same caller, task and repository checks, then main fetches
// origin's default branch and the task branch into their remote-tracking refs
// (main/worktask/taskFetch.ts): for a worker whose shell has no credentials
// for origin. Never a push, never the checkout.
//
// Both run git on the repository main recorded for the task
// (worktask/taskGitCommonDir.ts), and their network calls in clean git dirs
// under <wmux>/factory/git-clean, swept when this registers (main's start).

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { isOpenLedgerStatus, noChangesReceiptCurrent, type TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { getWmuxDir } from '../../../daemon/config';
import { readBotWorkerDefaultBranches } from '../../../shared/botWorkerGuard';
import { readRepoDefaultBranchByKey } from '../../agents/botWorkerDefaultBranch';
import { getBotStore } from '../../factory/botStore';
import { pushTaskBranch, sweepTaskGitRelays, type TaskOriginPinInput, type TaskPushGit, type TaskPushResult } from '../../worktask/taskPush';
import { recordedTaskGitCommonDir, recordedTaskGitWorktreeDir } from '../../worktask/taskGitCommonDir';
import { taskPushRecordOf, type TaskPushRecord } from '../../worktask/taskPushRecord';
import { fetchTaskRefs } from '../../worktask/taskFetch';
import { reclaimedWorkerOfPane } from '../../factory/workerReclaim';
import type { ReclaimedWorker } from '../../factory/workerReclaim';
import type { LedgerEntry } from '../../../shared/ledger';

type GetWindow = () => BrowserWindow | null;

export interface TaskPushRpcDeps {
  getWindow: GetWindow;
  daemon: { rpc(method: string, params: Record<string, unknown>): Promise<unknown> };
  /** Injected in tests. */
  getLedger?: () => TaskLedger;
  resolveCallerWorkspace?: (senderPtyId: string) => Promise<string | null>;
  wmuxDir?: () => string;
  git?: TaskPushGit;
  push?: typeof pushTaskBranch;
  fetch?: typeof fetchTaskRefs;
  /** The repository's own default branch, by its `host/owner/repo` key. */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
  /** A bot's repository key (its profile). */
  botRepoKey?: (botId: string) => string | undefined;
  /** A bot's repository folder (its profile), for a task whose row records
   *  no git dir. */
  botRepoPath?: (botId: string) => string | undefined;
  /** A bot's origin pin (its profile), for a task whose row records none. */
  botOriginPin?: (botId: string) => string | undefined;
  /** Where a landed push is recorded (default: the one under wmuxDir). */
  pushRecord?: Pick<TaskPushRecord, 'record' | 'begin' | 'end'>;
  /** The reclaimed worker whose recorded pane this is (default: the
   *  reclaimed workers' record). */
  reclaimedWorkerOfPane?: (workspaceId: string, ptyId: string) => Pick<ReclaimedWorker, 'taskId' | 'botId' | 'ownerWorkspaceId'> | null;
  /** Whether a folder exists (a resumed worker's worktree). */
  exists?: (p: string) => boolean;
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

interface MissionTask { id: string; status?: string; branch?: string; worktreePath?: string; detachedAt?: number }

export function registerTaskPushRpc(router: RpcRouter, deps: TaskPushRpcDeps): void {
  const ledgerOf = deps.getLedger ?? getTaskLedger;
  const resolveCaller = deps.resolveCallerWorkspace ?? (async (pty: string) => {
    try {
      return await resolvePtyOwnerWorkspace(deps.getWindow, pty);
    } catch {
      return null;
    }
  });
  const push = deps.push ?? pushTaskBranch;
  const relayRootOf = (dir: string) => path.join(dir, 'factory', 'git-relay');
  // Relays whose task is no longer open are swept at registration.
  sweepTaskGitRelays(relayRootOf((deps.wmuxDir ?? getWmuxDir)()), (taskId) => {
    try {
      const e = ledgerOf().get(taskId);
      return e ? isOpenLedgerStatus(e.status) : false;
    } catch {
      // Keep it when the ledger cannot be read: a resumed worker may still use it.
      return true;
    }
  });

  type Resolved = { ok: true; row: { id: string; ownerWorkspaceId: string; dispatch?: { origin?: { kind?: string; botId?: string } } }; task: Required<Pick<MissionTask, 'branch' | 'worktreePath'>>; dir: string; gitCommonDir: string; gitWorktreeDir: string | null; expectedRepoKey?: string; pin: TaskOriginPinInput }
    | { ok: false; error: { code: string; message: string } };

  /** The caller's own task (its open one, or the ended one a resumed
   *  worker's recorded pane stands for), its worktree branch and the
   *  repository it must be in: a bot's, from the dispatch (else the bot's
   *  profile); another task's, from the dispatch when `recordedRepo` asks
   *  for one. `words` finish the refusals' sentences. */
  const resolveWorkerTask = async (
    method: string, params: Record<string, unknown>, ctx: RpcContext | undefined,
    words: { worker: string; branch: string; repo: string },
    opts: { recordedRepo?: boolean } = {},
  ): Promise<Resolved> => {
    if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', `${method} is local-origin only`);
    if (ctx?.commanderWorkspace || ctx?.bot) {
      return deny('NOT_AUTHORIZED', `${method}: only a task's own worker ${words.worker}`);
    }
    const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
    const workspaceId = senderPtyId ? await resolveCaller(senderPtyId) : null;
    if (!workspaceId) return deny('NOT_AUTHORIZED', `${method}: caller identity could not be resolved (no resolvable senderPtyId)`);
    let row: LedgerEntry | null = ledgerOf().findOpenByTaskWorkspace(workspaceId);
    let resumed = false;
    if (!row) {
      let rec: Pick<ReclaimedWorker, 'taskId' | 'botId' | 'ownerWorkspaceId'> | null = null;
      try {
        rec = (deps.reclaimedWorkerOfPane ?? reclaimedWorkerOfPane)(workspaceId, senderPtyId);
      } catch {
        rec = null;
      }
      const ended = rec ? ledgerOf().get(rec.taskId) : null;
      if (rec && ended && ended.dispatch?.origin.kind === 'bot' && ended.dispatch.origin.botId === rec.botId && ended.ownerWorkspaceId === rec.ownerWorkspaceId) {
        row = ended;
        resumed = true;
      }
    }
    if (!row) return deny('NOT_FOUND', `${method}: no open task belongs to your workspace`);
    const own = row;
    if (row.dispatch?.checkout) {
      return deny('FAILED_PRECONDITION', `${method}: this task is a detached checkout of one commit; it has no branch ${words.branch}`);
    }
    let listed: { ok?: boolean; tasks?: MissionTask[] } | undefined;
    try {
      listed = (await deps.daemon.rpc('task.mission.list', { verifiedWorkspaceId: own.ownerWorkspaceId })) as typeof listed;
    } catch (err) {
      return deny('UNAVAILABLE', `${method}: could not read the task record: ${err instanceof Error ? err.message : String(err)}`);
    }
    const task = Array.isArray(listed?.tasks) ? listed.tasks.find((t) => t.id === own.id) : undefined;
    // A resumed worker's ended task: while its worktree branch is still there.
    if (!task || (task.status !== 'open' && !resumed) || task.detachedAt !== undefined) {
      return deny('FAILED_PRECONDITION', `${method}: the task is not open`);
    }
    if (!task.branch || !task.worktreePath || (resumed && !(deps.exists ?? fs.existsSync)(task.worktreePath))) {
      return deny('FAILED_PRECONDITION', `${method}: the task has no worktree branch ${words.branch}`);
    }
    const dir = (deps.wmuxDir ?? getWmuxDir)();
    // A bot's task works only in the repository it was started in (the
    // dispatch's, else the bot's own); another task, when `recordedRepo`
    // asks, only in the one its dispatch recorded.
    const origin = own.dispatch?.origin;
    let expectedRepoKey: string | undefined = own.dispatch?.repoKey;
    if (origin?.kind === 'bot') {
      expectedRepoKey ??= origin.botId ? (deps.botRepoKey ?? ((id: string) => getBotStore()?.get(id)?.repo?.repoKey))(origin.botId) : undefined;
      if (!expectedRepoKey) return deny('FAILED_PRECONDITION', `${method}: the task's bot names no repository ${words.repo}`);
    } else if (opts.recordedRepo && !expectedRepoKey) {
      return deny('FAILED_PRECONDITION', `${method}: wmux recorded no origin for this task ${words.repo}`);
    }
    // The repository's git dir, as main recorded it (never the worktree's).
    const gitCommonDir = await recordedTaskGitCommonDir(own.dispatch, deps.botRepoPath ?? ((id: string) => getBotStore()?.get(id)?.repo?.repoPath), deps.git);
    if (!gitCommonDir) return deny('FAILED_PRECONDITION', `${method}: wmux recorded no repository folder for this task ${words.repo}; start a new task`);
    const gitWorktreeDir = await recordedTaskGitWorktreeDir(own.dispatch, gitCommonDir, task.worktreePath);
    // origin's exact address: the dispatch's pin, else the bot's profile's;
    // a row with neither is pinned at this first use.
    const expectedOriginPin = own.dispatch?.originPin
      ?? (origin?.kind === 'bot' && origin.botId ? (deps.botOriginPin ?? ((id: string) => getBotStore()?.get(id)?.repo?.originPin))(origin.botId) : undefined);
    const pin: TaskOriginPinInput = expectedOriginPin
      ? { expectedOriginPin }
      : { recordOriginPin: (p: string) => ledgerOf().recordOriginPin(own.id, p) };
    return { ok: true, row: own, task: { branch: task.branch, worktreePath: task.worktreePath }, dir, gitCommonDir, gitWorktreeDir, ...(expectedRepoKey ? { expectedRepoKey } : {}), pin };
  };

  router.register('task.push', async (params, ctx?: RpcContext) => {
    // task_push applies the same remote and ref checks as task_fetch: the
    // origin main recorded for the task.
    const r = await resolveWorkerTask('task.push', params, ctx, { worker: 'pushes its branch', branch: 'to publish', repo: 'to push to' }, { recordedRepo: true });
    if (!r.ok) return r;
    // Main's own record of what was published: the no-changes check reads it
    // (factory/noChangesCheck.ts) and answers `unknown` while this push is
    // under way. Marked in the same tick as the check below, so no
    // completion can be checked in between.
    const record = deps.pushRecord ?? taskPushRecordOf(r.dir);
    record.begin(r.row.id);
    try {
      // A report the system checked as making no changes stands on that: a
      // commit published now would be completed with it, ungated. The bot
      // sends the task back first; the worker's next report is checked anew.
      const now = ledgerOf().get(r.row.id);
      if (now?.status === 'review_requested' && now.gate?.skipped === 'no_changes' && noChangesReceiptCurrent(now)) {
        return deny('FAILED_PRECONDITION', 'task.push: this task\'s report was checked as making no changes, and that report stands; to publish commits, ask the bot to send the task back, then report again');
      }
      // Completed on that check (a resumed worker of an ended task pushes
      // otherwise): nothing gated it, so nothing of it is published. Only a
      // skip that still governs the row: one recorded for its last report
      // (the ledger takes `completed` on no other), not a merge completion.
      // A skip a later report superseded completed nothing.
      if (now?.status === 'completed' && now.gate?.skipped === 'no_changes' && noChangesReceiptCurrent(now) && now.completion?.source !== 'merge') {
        return deny('FAILED_PRECONDITION', 'task.push: this task was completed as making no changes; commits made since are not published from it (start a new task for them)');
      }
      const result: TaskPushResult = await push({
        worktreePath: r.task.worktreePath,
        branch: r.task.branch,
        defaultBranches: readBotWorkerDefaultBranches(r.dir),
        noHooksDir: path.join(r.dir, 'factory', 'no-hooks'),
        gitCommonDir: r.gitCommonDir,
        ...(r.gitWorktreeDir ? { gitWorktreeDir: r.gitWorktreeDir } : {}),
        relayRoot: relayRootOf(r.dir),
        taskId: r.row.id,
        ...(r.expectedRepoKey ? { expectedRepoKey: r.expectedRepoKey } : {}),
        ...r.pin,
        // Every task, bot or not: the repository's own default branch too (a
        // task branch can be named by a person), read by the pushed-to key.
        repoDefaultBranch: deps.repoDefaultBranch ?? ((key: string) => readRepoDefaultBranchByKey(key)),
      }, ...(deps.git ? [deps.git] : []));
      if (result.ok) record.record(r.row.id, result.head);
      return { ...result, taskId: r.row.id };
    } finally {
      record.end(r.row.id);
    }
  });

  router.register('task.fetch', async (params, ctx?: RpcContext) => {
    // Fetch uses the origin main recorded for the task.
    const r = await resolveWorkerTask('task.fetch', params, ctx, { worker: 'fetches for it', branch: 'to fetch', repo: 'to fetch from' }, { recordedRepo: true });
    if (!r.ok) return r;
    const result = await (deps.fetch ?? fetchTaskRefs)({
      worktreePath: r.task.worktreePath,
      branch: r.task.branch,
      noHooksDir: path.join(r.dir, 'factory', 'no-hooks'),
      gitCommonDir: r.gitCommonDir,
      relayRoot: relayRootOf(r.dir),
      taskId: r.row.id,
      ...(r.expectedRepoKey ? { expectedRepoKey: r.expectedRepoKey } : {}),
      ...r.pin,
      repoDefaultBranch: deps.repoDefaultBranch ?? ((key: string) => readRepoDefaultBranchByKey(key)),
    }, ...(deps.git ? [deps.git] : []));
    return { ...result, taskId: r.row.id };
  });
}
