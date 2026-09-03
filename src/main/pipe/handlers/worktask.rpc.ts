// ─── task.gate.* / task.adopt / task.close / task.pr on the pipe ─────────────
//
// Closing a task, opening its PR, adopting its result and running its gate were
// all reachable from exactly one place: the Electron renderer, over ipcMain. An
// orchestrator brain is not a renderer, so it could start N tasks and then do
// nothing with any of them — it could only ask a human to click. These five
// methods are that missing half, and they are deliberately the SAME services the
// GUI drives (TaskCloseService, TaskPrService, TaskGateRunner, TaskAdoptService)
// rather than a second implementation with its own rules.
//
// The gates, in the order they run, and all of them verbatim from the fan-out
// handler next door (fanout.rpc.ts) because these calls are strictly more
// destructive than spawning a worktree:
//
//   R4 origin allowlist — `ctx.origin === 'local'` or reject. A remote caller
//      never closes a task or writes to a repository.
//   R2 identity — the caller's workspace is SERVER-RESOLVED: a commander token
//      (ctx.commanderWorkspace) outranks a stated senderPtyId, and a pane agent
//      is resolved from its verified pty. A caller-supplied
//      `verifiedWorkspaceId` is REJECTED, not ignored — being silently
//      overruled leaves a caller believing it acted as someone it is not.
//   Ownership — the task must appear in `task.mission.list` scoped to that
//      resolved workspace. That list is owner-scoped by the daemon, so "not in
//      it" covers both "no such task" and "someone else's task"; the two are
//      reported apart only where doing so leaks nothing (an unknown id is not
//      evidence of another workspace's task, because the answer is the same).
//   Materialization — close/pr/adopt/gate all need a worktree on disk. A task
//      that never materialized is refused with that reason rather than a
//      confusing git error.
//
// Approval: none is raised here. These methods are reached from MCP tools, and
// an MCP tool call passes through the existing PreToolUse permission gate
// (GateBroker) before it ever becomes an RPC — so adding a second prompt would
// ask the user twice for one action. `task.close` is teardown-class and must be
// listed in TEARDOWN_DENY_METHODS on the commander surface; see
// docs/internal/orch-o2-tool-contract.md.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';

import type { RpcRouter } from '../RpcRouter';
import type { RpcContext, RpcMethod } from '../../../shared/rpc';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { git as runGit } from '../../git/git';
import { metaDirForWorktree } from '../../worktask/TaskWorktreeManager';
import type { TaskCloseService } from '../../worktask/TaskCloseService';
import type { TaskPrService } from '../../worktask/TaskPrService';
import type { TaskAdoptService } from '../../worktask/TaskAdoptService';
import type { TaskGateRunner } from '../../worktask/TaskGateRunner';

type GetWindow = () => BrowserWindow | null;

/** The five methods this file registers. Named once so the contract doc, the
 *  MCP tools and lane F's allow-list all quote the same strings. */
export const WORKTASK_RPC_METHODS = [
  'task.gate.run',
  'task.gate.cancel',
  'task.adopt',
  'task.close',
  'task.pr',
] as const;

export type WorktaskRpcMethod = (typeof WORKTASK_RPC_METHODS)[number];

/** Minimal daemon RPC surface (same shape as CloseDaemonPort). */
export interface WorktaskRpcDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface WorktaskRpcDeps {
  daemon: WorktaskRpcDaemonPort;
  getWindow: GetWindow;
  /** MUST be the same instances the renderer IPC handler drives. */
  close: TaskCloseService;
  pr: TaskPrService;
  adopt: TaskAdoptService;
  gate: TaskGateRunner;
  /** The daemon's own workspace id, used as the `system` actor on ledger
   *  writes. Defaults to 'ws-daemon'. */
  systemWorkspaceId?: string;
  /** Injected for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
}

/** Projection task, minimal shape (task.mission.list). */
interface ProjectionTask {
  id: string;
  title: string;
  status: 'open' | 'closed';
  branch?: string;
  worktreePath?: string;
  detachedAt?: number;
}

/** Typed wire error, shaped like the fan-out / mission envelopes so MCP tools
 *  can branch on `error.code` instead of parsing prose. */
function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

async function listMissions(daemon: WorktaskRpcDaemonPort, verifiedWorkspaceId: string): Promise<ProjectionTask[]> {
  const res = (await daemon.rpc('task.mission.list', { verifiedWorkspaceId })) as
    | { ok?: boolean; tasks?: ProjectionTask[] }
    | undefined;
  if (!res || res.ok !== true || !Array.isArray(res.tasks)) return [];
  return res.tasks;
}

/**
 * R2 — the caller's workspace, server-resolved. A validated commander binding
 * outranks a stated senderPtyId (the token is the stronger claim, and honouring
 * the pty field for a brain would let it aim at a workspace it is not bound to).
 */
async function resolveCaller(
  getWindow: GetWindow,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): Promise<{ workspaceId: string } | { code: string; message: string }> {
  if (params['verifiedWorkspaceId'] !== undefined) {
    return {
      code: 'INVALID_ARGUMENT',
      message: 'this method does not accept verifiedWorkspaceId — your workspace is resolved from your verified caller',
    };
  }
  const commanderWorkspaceId = ctx?.commanderWorkspace ?? '';
  const senderPtyId = commanderWorkspaceId
    ? ''
    : typeof params['senderPtyId'] === 'string'
      ? params['senderPtyId'].trim()
      : '';
  let workspaceId = commanderWorkspaceId;
  if (!workspaceId && senderPtyId) {
    try {
      workspaceId = (await resolvePtyOwnerWorkspace(getWindow, senderPtyId)) ?? '';
    } catch {
      workspaceId = '';
    }
  }
  if (!workspaceId) {
    return { code: 'NOT_AUTHORIZED', message: 'a verifiable caller is required (no resolvable senderPtyId)' };
  }
  if (workspaceId === HUMAN_WORKSPACE_ID) {
    return { code: 'NOT_AUTHORIZED', message: `'${HUMAN_WORKSPACE_ID}' is the reserved human workspace` };
  }
  return { workspaceId };
}

/** The caller + the task it named, or the wire error to answer with. */
async function resolveOwnedTask(
  deps: WorktaskRpcDeps,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): Promise<{ workspaceId: string; task: ProjectionTask } | { code: string; message: string }> {
  const taskId = typeof params['taskId'] === 'string' ? params['taskId'].trim() : '';
  if (!taskId) return { code: 'INVALID_ARGUMENT', message: 'taskId is required' };

  const caller = await resolveCaller(deps.getWindow, params, ctx);
  if (!('workspaceId' in caller)) return caller;

  const tasks = await listMissions(deps.daemon, caller.workspaceId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    // Owner-scoped list: unknown id and another workspace's id are the same
    // answer, and saying which would confirm a task exists elsewhere.
    return {
      code: 'NOT_FOUND',
      message: `no task '${taskId}' is owned by your workspace — list your missions to see the ones you may act on`,
    };
  }
  return { workspaceId: caller.workspaceId, task };
}

/** Repo root + repoHash for a task worktree. Same derivation (and same hash
 *  rule: sha256 of the realpath, 12 chars) the IPC close path uses, so the
 *  worktree mutex key matches whichever surface closed the task. */
async function resolveRepoInfo(worktreePath: string): Promise<{ repoRoot: string; repoHash: string } | null> {
  let commonDir = '';
  const modern = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
  if (modern.code === 0) {
    commonDir = modern.stdout.trim();
  } else {
    const legacy = await runGit(['rev-parse', '--git-common-dir'], worktreePath);
    if (legacy.code !== 0) return null;
    const raw = legacy.stdout.trim();
    commonDir = raw ? path.resolve(worktreePath, raw) : '';
  }
  if (!commonDir) return null;
  const top = await runGit(['rev-parse', '--show-toplevel'], path.dirname(commonDir));
  if (top.code !== 0) return null;
  const repoRoot = top.stdout.trim();
  if (!repoRoot) return null;
  let real = repoRoot;
  try {
    real = fs.realpathSync(repoRoot);
  } catch {
    // Unresolvable symlink — hash the path we have; the IPC path does the same.
  }
  return { repoRoot, repoHash: crypto.createHash('sha256').update(real).digest('hex').slice(0, 12) };
}

/**
 * Register the task-lifecycle pipe methods. `close`, `pr` and `gate` MUST be
 * the same service instances the renderer IPC handler uses — TaskWorktreeManager
 * keeps a per-repo mutex chain, and two instances would race for git's
 * index.lock.
 *
 * The methods are not yet in the `RpcMethod` union (lane F owns
 * src/shared/rpc.ts); the cast below is the seam, and it disappears the moment
 * the five strings are added there.
 */
export function registerWorktaskRpc(router: RpcRouter, deps: WorktaskRpcDeps): void {
  const systemWorkspaceId = deps.systemWorkspaceId ?? 'ws-daemon';
  const fileExists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const register = (method: WorktaskRpcMethod, handler: Parameters<RpcRouter['register']>[1]): void =>
    router.register(method as unknown as RpcMethod, handler);

  const localOnly = (ctx: RpcContext | undefined, method: string): { ok: false; error: { code: string; message: string } } | null =>
    ctx?.origin === 'local'
      ? null
      : deny('NOT_AUTHORIZED', `${method} is local-origin only (remote callers cannot act on tasks)`);

  // ── task.gate.run ────────────────────────────────────────────────────
  register('task.gate.run', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.gate.run');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk, so there is nothing to run a gate in`);
    }
    const result = await deps.gate.run({
      taskId: task.id,
      worktreePath: task.worktreePath,
      systemWorkspaceId,
    });
    // `busy` and `refused` are answers, not transport failures — the envelope
    // carries them so a poller can tell them apart without parsing text.
    return result.ok ? { ...result, title: task.title } : result;
  });

  // ── task.gate.cancel ─────────────────────────────────────────────────
  register('task.gate.cancel', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.gate.cancel');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    // Cancelling a gate that is not running is not an error: a caller racing a
    // gate that just finished should read `cancelled: false`, not a failure.
    return { ok: true as const, taskId: owned.task.id, cancelled: deps.gate.cancel(owned.task.id) };
  });

  // ── task.adopt ───────────────────────────────────────────────────────
  register('task.adopt', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.adopt');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task } = owned;
    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      return deny('FAILED_PRECONDITION', `task '${task.id}' has no worktree on disk, so it has produced nothing to adopt`);
    }
    return deps.adopt.adopt({ taskId: task.id, worktreePath: task.worktreePath });
  });

  // ── task.close ───────────────────────────────────────────────────────
  // Teardown-class: it removes a git worktree. TaskCloseService owns the order
  // contract (unpushed check → remove → mission.close → meta cleanup) and both
  // the dirty and unpushed refusals; this handler adds identity and the repo
  // derivation and changes none of it.
  register('task.close', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.close');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task, workspaceId } = owned;

    if (!task.worktreePath || !fileExists(task.worktreePath)) {
      // Nothing on disk to remove — close-only, exactly as the IPC path
      // reconciles an unmaterialized or already-deleted task.
      return deps.close.closeTask({ taskId: task.id, verifiedWorkspaceId: workspaceId });
    }
    const repo = await resolveRepoInfo(task.worktreePath);
    if (!repo) return deps.close.closeTask({ taskId: task.id, verifiedWorkspaceId: workspaceId });
    return deps.close.closeTask({
      taskId: task.id,
      verifiedWorkspaceId: workspaceId,
      repoRoot: repo.repoRoot,
      repoHash: repo.repoHash,
      worktreePath: task.worktreePath,
      metaDir: metaDirForWorktree(task.worktreePath),
    });
  });

  // ── task.pr ──────────────────────────────────────────────────────────
  register('task.pr', async (params, ctx?: RpcContext) => {
    const blocked = localOnly(ctx, 'task.pr');
    if (blocked) return blocked;
    const owned = await resolveOwnedTask(deps, params, ctx);
    if (!('task' in owned)) return deny(owned.code, owned.message);
    const { task, workspaceId } = owned;
    if (!task.worktreePath || !task.branch) {
      return deny(
        'FAILED_PRECONDITION',
        `task '${task.id}' has no worktree and branch yet, so there is no branch to open a PR from`,
      );
    }
    const body = typeof params['body'] === 'string' ? params['body'] : undefined;
    return deps.pr.createPr({
      taskId: task.id,
      verifiedWorkspaceId: workspaceId,
      worktreePath: task.worktreePath,
      branch: task.branch,
      title: task.title,
      ...(body !== undefined ? { body } : {}),
    });
  });
}
