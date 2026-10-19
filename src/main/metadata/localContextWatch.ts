import type { BrowserWindow } from 'electron';
import { GitContextWatcher } from '../pty/gitContextWatch';
import { PortWatcher } from '../pty/portWatch';
import {
  broadcastMetadataUpdate,
  onCwdUpdate,
  getCwd,
  updateBranch,
  removeBranch,
  markBranchAbsent,
  updateWorktree,
  updatePorts,
} from '../ipc/handlers/metadata.handler';
import { prStatusCache } from './PrStatusCache';
import type { PTYManager } from '../pty/PTYManager';

/**
 * X1 — local-mode (non-daemon) parity for the workspace-context watchers.
 *
 * In daemon mode the watchers live in the daemon process and reach main as
 * `context.git` / `context.ports` DaemonEvents (WorkspaceContextRouter). In
 * local mode main owns the PTYs, so the same two watcher classes run here,
 * keyed off the existing updateCwd() funnel (OSC 7 + prompt scrape + create
 * paths all converge there). Both modes produce identical
 * METADATA_UPDATE payloads — schema-freeze §1 delivery invariant.
 */
export function startLocalContextWatch(
  ptyManager: PTYManager,
  getWindow: () => BrowserWindow | null,
): () => void {
  const gitWatcher = new GitContextWatcher();
  const portWatcher = new PortWatcher(() => ptyManager.getActiveSessionPids());
  const branchByPty = new Map<string, string>();

  gitWatcher.on('git', (payload: { sessionId: string; branch: string | null; isWorktree: boolean; absent?: true }) => {
    const ptyId = payload.sessionId;
    const branch = payload.branch ?? '';
    // Same three answers as WorkspaceContextRouter: branch, known absent
    // (the poll spawns no git), unknown (the poll may ask git).
    if (branch) updateBranch(ptyId, branch);
    else if (payload.absent) markBranchAbsent(ptyId);
    else removeBranch(ptyId);
    updateWorktree(ptyId, payload.isWorktree);
    branchByPty.set(ptyId, branch);
    broadcastMetadataUpdate(getWindow(), {
      ptyId,
      gitBranch: branch,
      gitIsWorktree: payload.isWorktree,
      pr: null,
    });
    if (branch) {
      const cwd = getCwd(ptyId);
      if (cwd) {
        void prStatusCache.get(cwd, branch).then((pr) => {
          if (branchByPty.get(ptyId) !== branch) return;
          broadcastMetadataUpdate(getWindow(), { ptyId, pr });
        });
      }
    }
  });

  portWatcher.on('ports', (payload: { sessionId: string; ports: Array<{ port: number; pid: number }> }) => {
    const ports = [...new Set(payload.ports.map((p) => p.port))];
    updatePorts(payload.sessionId, ports);
    broadcastMetadataUpdate(getWindow(), {
      ptyId: payload.sessionId,
      listeningPorts: ports,
    });
  });

  const unsubCwd = onCwdUpdate((ptyId, cwd) => {
    // Only track PTYs this process actually owns — daemon-mode sessions
    // never reach this module (it is mounted only when daemonClient is null).
    gitWatcher.update(ptyId, cwd);
  });

  portWatcher.start();

  return () => {
    unsubCwd();
    portWatcher.stop();
    gitWatcher.dispose();
    branchByPty.clear();
  };
}
