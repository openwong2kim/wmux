// J3 task lifecycle IPC handlers (renderer → main). Same renderer-trusted identity as
// channelLocal/fanout (Electron process boundary, not exposed on pipe).
//
// 4 channels:
//   task:close        — TaskCloseService (remove success→close order inversion §1).
//   task:create-pr    — TaskPrService (gh 4-gate 1-click PR §2).
//   worktask:scan     — WorktaskScanService (disk source-of-truth cleanup scan §1).
//   worktask:refire   — refire on non-dispatch (prompt.md existence check then resend original initialCommand §3·F2).
//
// close/createPr take taskId only; materialization fields (branch/worktreePath/title) are
// reverse-looked up from daemon projection (task.mission.list) — removes surface where
// renderer sends stale fields and touches wrong worktree (single source of truth).

import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { RpcMethod } from '../../../shared/rpc';
import { TaskWorktreeManager, metaDirForWorktree } from '../../worktask/TaskWorktreeManager';
import { TaskCloseService } from '../../worktask/TaskCloseService';
import { TaskPrService } from '../../worktask/TaskPrService';
import { WorktaskScanService, type ScanOpenTask } from '../../worktask/WorktaskScanService';
import { prStatusCache } from '../../metadata/PrStatusCache';
import { getWmuxHomeDir } from '../../../shared/constants';
import { sanitizePtyText } from '../../../shared/types';
import { normalizeWorktreePath } from '../../../shared/workTask';

const execFileAsync = promisify(execFile);

/** Minimal projection task shape (task.mission.list return). */
interface ProjectionTask {
  id: string;
  title: string;
  status: 'open' | 'closed';
  branch?: string;
  worktreePath?: string;
  paneGroupId?: string;
  prUrl?: string;
}

export function registerWorktaskHandlers(getDaemonClient: () => DaemonClient | null): () => void {
  const daemonPort = {
    rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const dc = getDaemonClient();
      if (!dc) throw new Error('Daemon not connected');
      return dc.rpc(method as RpcMethod, params);
    },
  };

  // Single instance for process lifetime: TaskWorktreeManager must keep repoHash mutex chain
  // (blocks index.lock contention), so reuse it. Separate from fan-out instance but
  // cross-instance worktree add/remove contention is backstopped by git index.lock.
  const worktrees = new TaskWorktreeManager();
  const closeService = new TaskCloseService({ daemon: daemonPort, worktrees });
  const prService = new TaskPrService({ daemon: daemonPort, cache: prStatusCache });
  const scanService = new WorktaskScanService();

  // ── task:close ──────────────────────────────────────────────────────
  ipcMain.removeHandler(IPC.TASK_CLOSE);
  ipcMain.handle(
    IPC.TASK_CLOSE,
    wrapHandler(IPC.TASK_CLOSE, async (_event, raw: unknown) => {
      const { taskId, verifiedWorkspaceId, error } = parseTaskRef(raw);
      if (error) return { ok: false, taskId: '', reason: 'error' as const, error };

      const task = await resolveTask(daemonPort, taskId, verifiedWorkspaceId);
      if (!task) return { ok: false, taskId, reason: 'error' as const, error: 'task:close: task not found (missing projection)' };

      // F3 — close-only routing: missing worktreePath (unmaterialized CX4) / disk missing
      // (fs.existsSync false) / main repo unresolvable (corrupt worktree) → skip remove,
      // mission.close only. Aligns with scan disk-missing reconcile button and
      // TaskCloseService contract (remove success↔close failure crash retry).
      if (!task.worktreePath || !fs.existsSync(task.worktreePath)) {
        return closeService.closeTask({ taskId, verifiedWorkspaceId });
      }
      const repo = await resolveRepoInfo(task.worktreePath);
      if (!repo) {
        // Worktree dir exists but main repo unresolvable — remove would fail anyway,
        // close-only reconcile (prevent stuck-open forever).
        return closeService.closeTask({ taskId, verifiedWorkspaceId });
      }
      return closeService.closeTask({
        taskId,
        verifiedWorkspaceId,
        repoRoot: repo.repoRoot,
        repoHash: repo.repoHash,
        worktreePath: task.worktreePath,
        metaDir: metaDirForWorktree(task.worktreePath),
      });
    }),
  );

  // ── task:create-pr ──────────────────────────────────────────────────
  ipcMain.removeHandler(IPC.TASK_CREATE_PR);
  ipcMain.handle(
    IPC.TASK_CREATE_PR,
    wrapHandler(IPC.TASK_CREATE_PR, async (_event, raw: unknown) => {
      const { taskId, verifiedWorkspaceId, error } = parseTaskRef(raw);
      if (error) return { ok: false, reason: 'error' as const, error };

      const task = await resolveTask(daemonPort, taskId, verifiedWorkspaceId);
      if (!task) return { ok: false, reason: 'error' as const, error: 'task:create-pr: task not found' };
      if (!task.worktreePath || !task.branch) {
        return {
          ok: false,
          reason: 'error' as const,
          error: 'task:create-pr: unmaterialized task (missing worktree/branch) cannot create a PR',
        };
      }
      return prService.createPr({
        taskId,
        verifiedWorkspaceId,
        worktreePath: task.worktreePath,
        branch: task.branch,
        title: task.title,
      });
    }),
  );

  // ── worktask:scan ───────────────────────────────────────────────────
  ipcMain.removeHandler(IPC.WORKTASK_SCAN);
  ipcMain.handle(
    IPC.WORKTASK_SCAN,
    wrapHandler(IPC.WORKTASK_SCAN, async (_event, raw: unknown) => {
      const verifiedWorkspaceId =
        raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).verifiedWorkspaceId === 'string'
          ? ((raw as Record<string, unknown>).verifiedWorkspaceId as string)
          : '';
      if (!verifiedWorkspaceId) {
        return { ok: false, error: 'worktask:scan: verifiedWorkspaceId is required', scannedRoot: '', entries: [] };
      }
      const tasks = await listMissions(daemonPort, verifiedWorkspaceId);
      // Source of truth = disk, auxiliary = projection (§1 CL5). Reconcile open set =
      // daemon authoritative list (request owner) ∪ all open known to renderer (prevents
      // active worktrees from other parent workspaces classified as orphan). Dedup by taskId.
      const byId = new Map<string, ScanOpenTask>();
      for (const t of tasks) {
        if (t.status !== 'open') continue;
        // Daemon list is request-owner scoped, so owner = verifiedWorkspaceId (F1: close is
        // owner-scoped authz; attach owner on entry so reconcile button uses correct identity).
        byId.set(t.id, {
          taskId: t.id,
          title: t.title,
          ownerWorkspaceId: verifiedWorkspaceId,
          ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
        });
      }
      const known = Array.isArray((raw as Record<string, unknown>).knownOpen)
        ? ((raw as Record<string, unknown>).knownOpen as unknown[])
        : [];
      for (const k of known) {
        if (!k || typeof k !== 'object') continue;
        const kt = k as Record<string, unknown>;
        const taskId = typeof kt.taskId === 'string' ? kt.taskId : '';
        if (!taskId || byId.has(taskId)) continue;
        byId.set(taskId, {
          taskId,
          title: typeof kt.title === 'string' ? kt.title : taskId,
          // Other parent's task: use owner from renderer (fallback to request owner).
          ownerWorkspaceId: typeof kt.ownerWorkspaceId === 'string' ? kt.ownerWorkspaceId : verifiedWorkspaceId,
          ...(typeof kt.worktreePath === 'string' ? { worktreePath: kt.worktreePath } : {}),
        });
      }
      const result = await scanService.scan([...byId.values()]);
      return { ok: true, ...result };
    }),
  );

  // ── worktask:refire ─────────────────────────────────────────────────
  // Refire on non-dispatch (§3·F2). Exhausted pane never got startup command = bare shell
  // (no agent). Raw prompt would run as shell command, so resend original
  // initialCommand (agent launch + `$(cat prompt.md)` injection) with same
  // sanitizePtyText rules as normal path. Reject if prompt.md lost (no source to refire).
  // (F7: worktreePath must be under dedicated root — blocks path oracle.)
  ipcMain.removeHandler(IPC.WORKTASK_REFIRE);
  ipcMain.handle(
    IPC.WORKTASK_REFIRE,
    wrapHandler(IPC.WORKTASK_REFIRE, async (_event, raw: unknown) => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const ptyId = typeof r.ptyId === 'string' ? r.ptyId : '';
      const worktreePath = typeof r.worktreePath === 'string' ? r.worktreePath : '';
      const initialCommand = typeof r.initialCommand === 'string' ? r.initialCommand : '';
      if (!ptyId || !worktreePath || !initialCommand) {
        return { ok: false as const, error: 'worktask:refire: ptyId, worktreePath, and initialCommand are required' };
      }
      // F7 — verify worktreePath is under dedicated root ({wmux home}/worktrees). Block
      // oracle/escape probing prompt.md existence on arbitrary paths.
      if (!isUnderWorktreeRoot(worktreePath)) {
        return { ok: false as const, error: 'worktask:refire: worktreePath is outside the dedicated root' };
      }
      // prompt.md existence check (meaningless if `$(cat …)` target in initialCommand is gone).
      const promptPath = path.join(metaDirForWorktree(worktreePath), 'prompt.md');
      if (!fs.existsSync(promptPath)) {
        return { ok: false as const, error: 'Prompt file is missing — no original to refire' };
      }
      const dc = getDaemonClient();
      if (!dc) return { ok: false as const, error: 'worktask:refire: daemon not connected' };
      // Same as normal path (scheduleInitialCommand.write): sanitize + CR.
      dc.writeToSession(ptyId, sanitizePtyText(initialCommand) + '\r');
      return { ok: true as const };
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.TASK_CLOSE);
    ipcMain.removeHandler(IPC.TASK_CREATE_PR);
    ipcMain.removeHandler(IPC.WORKTASK_SCAN);
    ipcMain.removeHandler(IPC.WORKTASK_REFIRE);
  };
}

/** F7 — after normalizing worktreePath, is it under dedicated root ({wmux home}/worktrees)?
 *  Collapse `..` via path.resolve first — normalizeWorktreePath only handles separators/case,
 *  so `{root}/worktrees/../../etc` alone would pass prefix check. */
function isUnderWorktreeRoot(worktreePath: string): boolean {
  const root = normalizeWorktreePath(path.resolve(getWmuxHomeDir(), 'worktrees'));
  const p = normalizeWorktreePath(path.resolve(worktreePath));
  return p === root || p.startsWith(root + '/');
}

/** Defensive parse of {taskId, verifiedWorkspaceId} (renderer trusted but shape validated). */
function parseTaskRef(raw: unknown): { taskId: string; verifiedWorkspaceId: string; error?: string } {
  if (!raw || typeof raw !== 'object') return { taskId: '', verifiedWorkspaceId: '', error: 'Request object is required' };
  const r = raw as Record<string, unknown>;
  const taskId = typeof r.taskId === 'string' ? r.taskId : '';
  const verifiedWorkspaceId = typeof r.verifiedWorkspaceId === 'string' ? r.verifiedWorkspaceId : '';
  if (!taskId) return { taskId, verifiedWorkspaceId, error: 'taskId is required' };
  if (!verifiedWorkspaceId) return { taskId, verifiedWorkspaceId, error: 'verifiedWorkspaceId is required' };
  return { taskId, verifiedWorkspaceId };
}

/** task.mission.list → task array (defensive shape). */
async function listMissions(
  daemon: { rpc(m: string, p: Record<string, unknown>): Promise<unknown> },
  verifiedWorkspaceId: string,
): Promise<ProjectionTask[]> {
  const res = (await daemon.rpc('task.mission.list', { verifiedWorkspaceId })) as {
    ok?: boolean;
    tasks?: ProjectionTask[];
  };
  if (!res || res.ok !== true || !Array.isArray(res.tasks)) return [];
  return res.tasks;
}

/** taskId → projection task (owner scope). null if absent. */
async function resolveTask(
  daemon: { rpc(m: string, p: Record<string, unknown>): Promise<unknown> },
  taskId: string,
  verifiedWorkspaceId: string,
): Promise<ProjectionTask | null> {
  const tasks = await listMissions(daemon, verifiedWorkspaceId);
  return tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * worktree path → main repo root + repoHash. Same shape as diff.handler.resolveTargetRepo:
 * run `--show-toplevel` from parent of common-dir (`<repo>/.git`) to get main repo root
 * (direct --show-toplevel from worktree cwd returns the worktree itself). repoHash uses
 * same rule as preflight (realpath sha256 12 chars) so mutex key aligns.
 */
async function resolveRepoInfo(worktreePath: string): Promise<{ repoRoot: string; repoHash: string } | null> {
  try {
    // F10 — `--path-format=absolute` requires git≥2.31. On failure (old git), retry without
    // flag and absolutize mixed relative/absolute output against worktreePath.
    let commonDir: string;
    try {
      const common = await execFileAsync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: worktreePath, timeout: 30000, windowsHide: true },
      );
      commonDir = common.stdout.trim();
    } catch {
      const legacy = await execFileAsync(
        'git',
        ['rev-parse', '--git-common-dir'],
        { cwd: worktreePath, timeout: 30000, windowsHide: true },
      );
      const raw = legacy.stdout.trim();
      commonDir = raw ? path.resolve(worktreePath, raw) : '';
    }
    if (!commonDir) return null;
    const top = await execFileAsync(
      'git',
      ['-C', path.dirname(commonDir), 'rev-parse', '--show-toplevel'],
      { cwd: worktreePath, timeout: 30000, windowsHide: true },
    );
    const repoRoot = top.stdout.trim();
    if (!repoRoot) return null;
    let real: string;
    try {
      real = fs.realpathSync(repoRoot);
    } catch {
      real = repoRoot;
    }
    const repoHash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
    return { repoRoot, repoHash };
  } catch {
    return null;
  }
}
