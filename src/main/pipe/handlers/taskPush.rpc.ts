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

import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { getWmuxDir } from '../../../daemon/config';
import { readBotWorkerDefaultBranches } from '../../../shared/botWorkerGuard';
import { readRepoDefaultBranchByKey } from '../../agents/botWorkerDefaultBranch';
import { getBotStore } from '../../factory/botStore';
import { pushTaskBranch, type TaskPushGit, type TaskPushResult } from '../../worktask/taskPush';
import { taskPushRecordOf, type TaskPushRecord } from '../../worktask/taskPushRecord';

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
  /** The repository's own default branch, by its `host/owner/repo` key. */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
  /** A bot's repository key (its profile). */
  botRepoKey?: (botId: string) => string | undefined;
  /** Where a landed push is recorded (default: the one under wmuxDir). */
  pushRecord?: Pick<TaskPushRecord, 'record'>;
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

  router.register('task.push', async (params, ctx?: RpcContext) => {
    if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', 'task.push is local-origin only');
    if (ctx?.commanderWorkspace || ctx?.bot) {
      return deny('NOT_AUTHORIZED', 'task.push: only a task\'s own worker pushes its branch');
    }
    const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
    const workspaceId = senderPtyId ? await resolveCaller(senderPtyId) : null;
    if (!workspaceId) return deny('NOT_AUTHORIZED', 'task.push: caller identity could not be resolved (no resolvable senderPtyId)');
    const row = ledgerOf().findOpenByTaskWorkspace(workspaceId);
    if (!row) return deny('NOT_FOUND', 'task.push: no open task belongs to your workspace');
    if (row.dispatch?.checkout) {
      return deny('FAILED_PRECONDITION', 'task.push: this task is a detached checkout of one commit; it has no branch to publish');
    }
    let listed: { ok?: boolean; tasks?: MissionTask[] } | undefined;
    try {
      listed = (await deps.daemon.rpc('task.mission.list', { verifiedWorkspaceId: row.ownerWorkspaceId })) as typeof listed;
    } catch (err) {
      return deny('UNAVAILABLE', `task.push: could not read the task record: ${err instanceof Error ? err.message : String(err)}`);
    }
    const task = Array.isArray(listed?.tasks) ? listed.tasks.find((t) => t.id === row.id) : undefined;
    if (!task || task.status !== 'open' || task.detachedAt !== undefined) {
      return deny('FAILED_PRECONDITION', 'task.push: the task is not open');
    }
    if (!task.branch || !task.worktreePath) {
      return deny('FAILED_PRECONDITION', 'task.push: the task has no worktree branch to publish');
    }
    const dir = (deps.wmuxDir ?? getWmuxDir)();
    // A bot's task lands only in the bot's own repository.
    const origin = row.dispatch?.origin;
    let expectedRepoKey: string | undefined;
    if (origin?.kind === 'bot') {
      expectedRepoKey = origin.botId ? (deps.botRepoKey ?? ((id: string) => getBotStore()?.get(id)?.repo?.repoKey))(origin.botId) : undefined;
      if (!expectedRepoKey) return deny('FAILED_PRECONDITION', 'task.push: the task\'s bot names no repository to push to');
    }
    const result: TaskPushResult = await push({
      worktreePath: task.worktreePath,
      branch: task.branch,
      defaultBranches: readBotWorkerDefaultBranches(dir),
      noHooksDir: path.join(dir, 'factory', 'no-hooks'),
      ...(expectedRepoKey ? { expectedRepoKey } : {}),
      // Every task, bot or not: the repository's own default branch too (a
      // task branch can be named by a person), read by the pushed-to key.
      repoDefaultBranch: deps.repoDefaultBranch ?? ((key: string) => readRepoDefaultBranchByKey(key)),
    }, ...(deps.git ? [deps.git] : []));
    // Main's own record of what was published: the task gate reads it before
    // it skips a task as having made no changes (taskPushRecord.ts).
    if (result.ok) (deps.pushRecord ?? taskPushRecordOf(dir)).record(row.id, result.head);
    return { ...result, taskId: row.id };
  });
}
