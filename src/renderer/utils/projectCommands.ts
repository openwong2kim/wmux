// Project command execution (X5 wmux.json) — runs a trusted custom command
// in a NEW surface tab on the workspace's active pane, with cwd pinned to the
// project root. A new tab (not the active terminal) so we never inject text
// into whatever the user is mid-typing — same posture tmuxinator takes.
//
// Trust is re-checked against the store HERE, immediately before spawn, so a
// palette/sidebar item rendered before a trust revocation can't still execute.

import { useStore } from '../stores';
import { withDefaultShell, withWorkspaceProfile } from './ptyCreateOptions';
import { probeProjectConfig } from './projectConfigProbe';
import type { WmuxProjectCommand } from '../../shared/wmuxProjectConfig';

export interface RunProjectCommandResult {
  ok: boolean;
  reason?: 'untrusted' | 'unknown-command' | 'no-workspace' | 'spawn-failed';
}

export async function runProjectCommand(
  workspaceId: string,
  commandId: string,
): Promise<RunProjectCommandResult> {
  // TOCTOU re-probe: re-read the live file before running anything. The
  // cached store entry only ever holds approved bytes, but if the file was
  // edited since approval the probe demotes to 'stale' and we refuse here —
  // matching the dialog/badge the user will see.
  const probed = await probeProjectConfig(workspaceId);
  if (probed && probed.trust !== 'trusted') {
    useStore.getState().pushToast({
      level: 'warn',
      message: 'wmux.json changed or is no longer trusted — review it from the sidebar badge',
    });
    return { ok: false, reason: 'untrusted' };
  }
  const state = useStore.getState();
  const project = state.projectConfigs[workspaceId];
  // The trust gate. 'stale'/'denied'/'untrusted' all stop here.
  if (!project || project.trust !== 'trusted' || !project.root) {
    return { ok: false, reason: 'untrusted' };
  }
  const command = project.config?.commands?.find((c) => c.id === commandId);
  if (!command) return { ok: false, reason: 'unknown-command' };

  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return { ok: false, reason: 'no-workspace' };
  const paneId = ws.activePaneId;

  try {
    const created = await window.electronAPI.pty.create(
      withWorkspaceProfile(
        withDefaultShell(
          {
            workspaceId,
            cwd: project.root,
            initialCommand: command.command,
          },
          state.defaultShell,
        ),
        ws.profile,
      ),
    ) as { id: string; shell?: string; cwd?: string };
    const fresh = useStore.getState();
    // Workspace might have been closed during the await.
    if (!fresh.workspaces.some((w) => w.id === workspaceId)) {
      void window.electronAPI.pty.dispose(created.id).catch(() => undefined);
      return { ok: false, reason: 'no-workspace' };
    }
    fresh.addSurface(paneId, created.id, command.title, created.cwd || project.root);
    return { ok: true };
  } catch (err) {
    useStore.getState().pushToast({
      level: 'error',
      message: `Project command failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ok: false, reason: 'spawn-failed' };
  }
}

/** Trusted commands for a workspace, or [] — the palette/sidebar item source. */
export function listProjectCommands(workspaceId: string): WmuxProjectCommand[] {
  const project = useStore.getState().projectConfigs[workspaceId];
  if (!project || project.trust !== 'trusted') return [];
  return project.config?.commands ?? [];
}
