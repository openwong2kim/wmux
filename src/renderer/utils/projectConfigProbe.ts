// Project config discovery glue (X5 wmux.json) — probes main for the nearest
// wmux.json above a workspace's cwd, stores the result, and runs the
// auto-apply policy. Kept out of React so the AppLayout effect, the trust
// dialog and the palette all share one code path.

import { useStore } from '../stores';
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import type { Workspace } from '../../shared/types';

/** Resolve the cwd used for discovery: live workspace cwd (X1 metadata,
 * seeded by the first pane and tracked via OSC 7) > profile startupCwd. */
export function workspaceProbeCwd(ws: Workspace): string | undefined {
  return ws.metadata?.cwd ?? ws.profile?.startupCwd;
}

/** Probe main for `workspaceId`'s project config and cache it in the store.
 * Returns the fresh state, or null when the workspace has no usable cwd. */
export async function probeProjectConfig(workspaceId: string): Promise<ProjectConfigState | null> {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const cwd = workspaceProbeCwd(ws);
  if (!cwd) {
    state.setProjectConfig(workspaceId, null);
    return null;
  }
  try {
    const result = await window.electronAPI.projectConfig.get(cwd);
    // Workspace may have closed during the await — a stale transient entry is
    // harmless, but don't resurrect one for a removed workspace.
    if (!useStore.getState().workspaces.some((w) => w.id === workspaceId)) return null;
    useStore.getState().setProjectConfig(workspaceId, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * A workspace is "fresh" when auto-applying a layout destroys nothing the
 * user built: a single leaf pane holding at most one surface (the shell that
 * AppLayout auto-created). Anything else — splits, extra tabs — means the
 * user has invested state, so layout becomes a manual palette action.
 */
export function isFreshWorkspace(ws: Workspace): boolean {
  if (ws.rootPane.type !== 'leaf') return false;
  return ws.rootPane.surfaces.length <= 1;
}

/**
 * Auto-apply policy ("이 repo 열면 자동 배치"): trusted + has layout + fresh
 * workspace + not yet attempted this run. Replaced PTYs are disposed here
 * (the slice stays electronAPI-free). Returns true when a layout was applied.
 */
export function maybeAutoApplyProjectLayout(workspaceId: string): boolean {
  const state = useStore.getState();
  const project = state.projectConfigs[workspaceId];
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws || !project) return false;
  if (project.trust !== 'trusted' || !project.config?.layout) return false;
  if (state.projectLayoutAutoApplied[workspaceId]) return false;
  if (!isFreshWorkspace(ws)) {
    // Mark anyway: the user's existing arrangement should not get clobbered
    // by a LATER fresh-looking moment (e.g. closing tabs back down to one).
    state.markProjectLayoutAutoApplied(workspaceId);
    return false;
  }
  state.markProjectLayoutAutoApplied(workspaceId);
  return applyProjectLayoutNow(workspaceId);
}

/** Apply the trusted layout immediately (manual palette/dialog action — no
 * freshness check) and dispose the PTYs of the replaced tree. */
export function applyProjectLayoutNow(workspaceId: string): boolean {
  const { ok, disposedPtyIds } = useStore.getState().applyProjectLayout(workspaceId);
  if (ok) {
    for (const ptyId of disposedPtyIds) {
      void window.electronAPI.pty.dispose(ptyId).catch(() => undefined);
    }
  }
  return ok;
}

/**
 * Manual layout apply with a TOCTOU re-probe: the cached store state only
 * ever holds APPROVED bytes (the probe wrote it under the approved hash), so
 * executing from cache is safe — but re-checking the live file first means a
 * tampered wmux.json refuses immediately ('stale') instead of silently
 * running the older approved layout while the file on disk says otherwise.
 */
export async function applyProjectLayoutFresh(workspaceId: string): Promise<boolean> {
  const fresh = await probeProjectConfig(workspaceId);
  if (fresh?.trust !== 'trusted') {
    useStore.getState().pushToast({ level: 'warn', message: 'wmux.json changed or is no longer trusted — review it from the sidebar badge' });
    return false;
  }
  return applyProjectLayoutNow(workspaceId);
}

/** Persist a trust decision, re-probe, and (on trust) try the auto-apply. */
export async function decideProjectTrust(
  workspaceId: string,
  decision: 'trusted' | 'denied' | 'clear',
): Promise<void> {
  const project = useStore.getState().projectConfigs[workspaceId];
  if (!project?.root) return;
  try {
    await window.electronAPI.projectConfig.setTrust(
      project.root,
      decision,
      // Bind the grant to the BYTES THE DIALOG SHOWED — if the file changed
      // while the dialog was open, main evaluates the live file as 'stale'.
      decision === 'clear' ? undefined : project.contentHash,
    );
  } catch (err) {
    useStore.getState().pushToast({
      level: 'error',
      message: `Failed to save trust decision: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  await probeProjectConfig(workspaceId);
  if (decision === 'trusted') maybeAutoApplyProjectLayout(workspaceId);
}
