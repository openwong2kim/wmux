import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import {
  broadcastMetadataUpdate,
  updateBranch,
  removeBranch,
  getCwd,
  removeCwd,
  updatePorts,
  removePorts,
  updateWorktree,
  removeWorktree,
} from '../ipc/handlers/metadata.handler';
import { prStatusCache } from './PrStatusCache';
import { gitSyncStatusCache } from './GitSyncStatusCache';

/**
 * X1 workspace-context sidebar — daemon-mode fold of `context.git` /
 * `context.ports` DaemonEvents into the renderer-facing METADATA_UPDATE
 * channel (the renderer's updateWorkspaceMetadata then publishes the
 * existing `workspace.metadata.changed` EventBus event for plugins/MCP —
 * schema-freeze §2 "main layer").
 *
 * Mirrors DaemonNotificationRouter's lifecycle: constructed and started
 * next to it on daemon connect, stopped on swap.
 */
export class WorkspaceContextRouter {
  private cleanups: Array<() => void> = [];
  /** Per-PTY branch, for PR lookups keyed on the branch actually folded. */
  private branchByPty = new Map<string, string>();

  constructor(
    private daemonClient: DaemonClient,
    private getWindow: () => BrowserWindow | null,
  ) {}

  /**
   * Resolve and broadcast the PR status for a PTY's current cwd/branch.
   * Fire-and-forget: quiet absence on every failure path. Guards against
   * a branch switch racing the gh subprocess — the response is dropped if
   * the PTY's branch moved on while gh ran.
   */
  private refreshPr(ptyId: string, branch: string): void {
    const cwd = getCwd(ptyId);
    if (!cwd) return;
    void prStatusCache.get(cwd, branch).then((pr) => {
      if (this.branchByPty.get(ptyId) !== branch) return;
      broadcastMetadataUpdate(this.getWindow(), { ptyId, pr });
    });
  }

  start(): void {
    const onGit = (payload: { sessionId: string; data: unknown }) => {
      try {
        const data = payload.data as { branch?: string | null; isWorktree?: boolean } | null;
        if (!data || typeof data !== 'object') return;
        const branch = typeof data.branch === 'string' ? data.branch : '';
        const isWorktree = data.isWorktree === true;
        // Keep the metadata poll's branch cache in sync so the 5 s tick
        // re-broadcasts the watcher value instead of exec-ing git.
        if (branch) updateBranch(payload.sessionId, branch);
        else removeBranch(payload.sessionId);
        updateWorktree(payload.sessionId, isWorktree);
        this.branchByPty.set(payload.sessionId, branch);
        // HEAD moved (branch switch, commit, reset) — the cached dirty/
        // ahead-behind is stale; drop it so the next 5 s poll refetches.
        const cwd = getCwd(payload.sessionId);
        if (cwd) gitSyncStatusCache.invalidate(cwd);
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId: payload.sessionId,
          gitBranch: branch,
          gitIsWorktree: isWorktree,
          // Branch changed (or left a repo) — the old PR no longer applies.
          // refreshPr below re-broadcasts the real one when gh resolves.
          pr: null,
        });
        if (branch) this.refreshPr(payload.sessionId, branch);
      } catch (err) {
        console.warn('[WorkspaceContextRouter] session:git error:', err);
      }
    };

    const onPorts = (payload: { sessionId: string; data: unknown }) => {
      try {
        const data = payload.data as { ports?: Array<{ port?: number; pid?: number }> } | null;
        if (!data || !Array.isArray(data.ports)) return;
        const ports = [...new Set(
          data.ports
            .map((p) => p?.port)
            .filter((p): p is number => Number.isInteger(p) && (p as number) > 0),
        )];
        updatePorts(payload.sessionId, ports);
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId: payload.sessionId,
          listeningPorts: ports,
        });
      } catch (err) {
        console.warn('[WorkspaceContextRouter] session:ports error:', err);
      }
    };

    const onSessionEnd = (payload: { sessionId: string }) => {
      this.branchByPty.delete(payload.sessionId);
      // Daemon mode disables the metadata poll's local liveness prune, so
      // this event is the cwd cache's only cleanup path.
      removeCwd(payload.sessionId);
      removeBranch(payload.sessionId);
      removeWorktree(payload.sessionId);
      removePorts(payload.sessionId);
    };

    this.daemonClient.on('session:git', onGit);
    this.daemonClient.on('session:ports', onPorts);
    this.daemonClient.on('session:died', onSessionEnd);
    this.daemonClient.on('session:destroyed', onSessionEnd);
    this.cleanups.push(
      () => this.daemonClient.off('session:git', onGit),
      () => this.daemonClient.off('session:ports', onPorts),
      () => this.daemonClient.off('session:died', onSessionEnd),
      () => this.daemonClient.off('session:destroyed', onSessionEnd),
    );
  }

  stop(): void {
    for (const fn of this.cleanups) {
      try { fn(); } catch (err) { console.warn('[WorkspaceContextRouter] cleanup error:', err); }
    }
    this.cleanups.length = 0;
    this.branchByPty.clear();
  }
}
