/**
 * TaskCloseService — task close orchestration (J3 §1, main-side).
 *
 * Ordering contract (review CX1·CX2·G2 — reversal of v1 "close first"):
 *   ⓪ upstream/ahead check — unpushed commits block close with warning
 *      (CX3: porcelain-clean ≠ harvest complete. PR suggestion is caller UI's job).
 *   ① worktree remove — TaskWorktreeManager.removeWorktree (internal porcelain
 *      re-check is the dirty source-of-truth gate — G1 TOCTOU absorbed by remove's
 *      internal check). If dirty, remove rejects + **close also deferred** (task stays
 *      open — removes "closed but deliverables remain" contradiction) + preserve list entry.
 *   ② mission.close (daemon RPC) only after successful remove. Archive failure is swallowed
 *      by daemon and boot reconcile converges — here we only pass through the result.
 *   ③ meta dir (prompt.md) delete — relaunch after task end is meaningless (§1).
 *
 * Crash between ②↔③ = closed task + meta remains → cleanup scan (disk source of truth).
 * Crash between ①↔② = open task + no worktree = unmaterialized remainder → same.
 *
 * Unmaterialized task (no worktreePath — CX4): skip worktree step, close only.
 * Caller UI runs reclaim confirmation dialog first (flag only here).
 */

import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TaskWorktreeManager } from './TaskWorktreeManager';
import { getGitExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/** Minimal daemon RPC surface (FanOutDaemonPort shape — injectable in tests). */
export interface CloseDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface CloseTaskInput {
  taskId: string;
  verifiedWorkspaceId: string;
  /** Materialization info (from daemon projection — absent means unmaterialized close). */
  repoRoot?: string;
  repoHash?: string;
  worktreePath?: string;
  metaDir?: string;
}

export type CloseTaskResult =
  | { ok: true; taskId: string; archivePending: boolean; unmaterialized?: boolean }
  | {
      ok: false;
      taskId: string;
      /** 'unpushed' = unpushed commit warning (no proceed) / 'dirty' = preserve + close deferred / 'error' = other */
      reason: 'unpushed' | 'dirty' | 'error';
      error: string;
      /** Path enrolled on dirty preserve. */
      preservedWorktree?: string;
      /** Ahead commit count for unpushed warning display. */
      aheadCount?: number;
    };

export interface TaskCloseServiceOptions {
  daemon: CloseDaemonPort;
  worktrees: TaskWorktreeManager;
}

export class TaskCloseService {
  private readonly daemon: CloseDaemonPort;
  private readonly worktrees: TaskWorktreeManager;

  constructor(opts: TaskCloseServiceOptions) {
    this.daemon = opts.daemon;
    this.worktrees = opts.worktrees;
  }

  async closeTask(input: CloseTaskInput): Promise<CloseTaskResult> {
    const { taskId } = input;

    // Unmaterialized close (CX4): skip entire worktree step — commit close only.
    if (!input.worktreePath) {
      const closed = await this.missionClose(taskId, input.verifiedWorkspaceId);
      if (!closed.ok) return { ok: false, taskId, reason: 'error', error: closed.error };
      return { ok: true, taskId, archivePending: closed.archivePending, unmaterialized: true };
    }

    // ⓪ upstream/ahead check (CX3): committed but unpushed deliverables → stop.
    const ahead = await this.aheadOfUpstream(input.worktreePath);
    if (ahead.kind === 'ahead') {
      return {
        ok: false,
        taskId,
        reason: 'unpushed',
        error: `close: ${ahead.count} commit(s) not pushed — create a PR or push, then close again`,
        aheadCount: ahead.count,
      };
    }
    // No upstream + local commits (fan-out advanced from base) — same warning.
    if (ahead.kind === 'no-upstream-with-commits') {
      return {
        ok: false,
        taskId,
        reason: 'unpushed',
        error: `close: branch has ${ahead.count} unpushed commit(s) — create a PR or push, then close again`,
        aheadCount: ahead.count,
      };
    }

    // ① worktree remove — internal porcelain re-check is dirty source-of-truth gate (G1).
    if (!input.repoRoot || !input.repoHash) {
      return { ok: false, taskId, reason: 'error', error: 'close: missing repoRoot/repoHash (incomplete materialization info)' };
    }
    const removed = await this.worktrees.removeWorktree(input.repoRoot, input.repoHash, input.worktreePath);
    if (!removed.ok) {
      if (removed.preserved) {
        // Dirty preserve — close deferred (task stays open, §1 contract).
        return {
          ok: false,
          taskId,
          reason: 'dirty',
          error: removed.error,
          preservedWorktree: input.worktreePath,
        };
      }
      return { ok: false, taskId, reason: 'error', error: removed.error };
    }

    // ② close commit only after successful remove.
    const closed = await this.missionClose(taskId, input.verifiedWorkspaceId);
    if (!closed.ok) {
      // remove already succeeded (was clean, no deliverable loss) — close failure leaves
      // open+no-worktree state; retry possible. Explicit error.
      return { ok: false, taskId, reason: 'error', error: closed.error };
    }

    // ③ meta dir (prompt.md) delete — failure is non-fatal (cleanup scan's job), no result impact.
    if (input.metaDir) {
      try {
        fs.rmSync(input.metaDir, { recursive: true, force: true });
      } catch {
        /* cleanup scan picks it up */
      }
    }

    return { ok: true, taskId, archivePending: closed.archivePending };
  }

  /** mission.close daemon RPC — pass archivePending (archive failure) in result (CX2). */
  private async missionClose(
    taskId: string,
    verifiedWorkspaceId: string,
  ): Promise<{ ok: true; archivePending: boolean } | { ok: false; error: string }> {
    try {
      const res = (await this.daemon.rpc('task.mission.close', {
        taskId,
        verifiedWorkspaceId,
      })) as { ok?: boolean; archivePending?: boolean; error?: { message?: string } };
      if (res && res.ok === true) {
        return { ok: true, archivePending: res.archivePending === true };
      }
      return { ok: false, error: res?.error?.message ?? 'task.mission.close failed' };
    } catch (err) {
      return { ok: false, error: `task.mission.close: ${(err as Error).message}` };
    }
  }

  /**
   * Ahead-of-upstream commit check (CX3). Three outcomes:
   *   - upstream exists: `rev-list --count @{upstream}..HEAD` > 0 → ahead
   *   - no upstream: fan-out base (merge-base untrackable) — branch commit presence via
   *     `rev-list --count HEAD --not --remotes` (commits on no remote).
   *   - check failure: conservatively pass (clean verdict is remove's porcelain as source of truth —
   *     this is a warning gate so fail-open is UX loss only, no data loss).
   */
  private async aheadOfUpstream(
    worktreePath: string,
  ): Promise<{ kind: 'clean' } | { kind: 'ahead' | 'no-upstream-with-commits'; count: number }> {
    try {
      const upstream = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd: worktreePath, timeout: 15000, env: getGitExecEnv() },
      ).then(
        () => true,
        () => false,
      );
      if (upstream) {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', '@{upstream}..HEAD'],
          { cwd: worktreePath, timeout: 15000, env: getGitExecEnv() },
        );
        const n = parseInt(stdout.trim(), 10);
        return n > 0 ? { kind: 'ahead', count: n } : { kind: 'clean' };
      }
      // Local-only repo with no remotes — push concept does not apply; skip warning (false-positive guard).
      const remotes = await execFileAsync('git', ['remote'], { cwd: worktreePath, timeout: 15000, env: getGitExecEnv() });
      if (remotes.stdout.trim().length === 0) return { kind: 'clean' };
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath, timeout: 15000, env: getGitExecEnv() },
      );
      const n = parseInt(stdout.trim(), 10);
      return n > 0 ? { kind: 'no-upstream-with-commits', count: n } : { kind: 'clean' };
    } catch {
      return { kind: 'clean' };
    }
  }
}
