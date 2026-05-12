import { useEffect } from 'react';
import { useStore } from '../stores';
import type { NotificationType, Pane, PaneLeaf } from '../../shared/types';
import { playNotificationSound } from './useNotificationSound';

function findSurfaceByPtyId(root: Pane, ptyId: string): { surfaceId: string; paneId: string } | null {
  if (root.type === 'leaf') {
    const surface = root.surfaces.find((s) => s.ptyId === ptyId);
    if (surface) return { surfaceId: surface.id, paneId: root.id };
    return null;
  }
  for (const child of root.children) {
    const found = findSurfaceByPtyId(child, ptyId);
    if (found) return found;
  }
  return null;
}

/** Check if a ptyId belongs to the active pane's active surface in a workspace */
function isActivePtySurface(ws: { rootPane: Pane; activePaneId: string }, ptyId: string): boolean {
  const findActiveLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findActiveLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findActiveLeaf(ws.rootPane);
  if (!leaf) return false;
  const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  return activeSurface?.ptyId === ptyId;
}

// Throttle notification sounds — min 2s between sounds of same type
const lastSoundTime: Record<string, number> = {};
const SOUND_THROTTLE_MS = 2000;

/**
 * Resolve a notification's destination workspace + (optional) surface.
 *
 * Order of preference:
 *  1. ptyId — strongest signal, originates from a specific surface
 *  2. workspaceId hint from the payload (e.g. external MCP notify with
 *     mcp.claimWorkspace context) — use the workspace's active surface
 *  3. Active workspace fallback — backward compat for CLI `wmux notify`
 *     which sends neither ptyId nor workspaceId
 */
function resolveNotificationTarget(
  state: ReturnType<typeof useStore.getState>,
  ptyId: string | null,
  workspaceIdHint: string | undefined,
): { workspaceId: string; surfaceId?: string } | null {
  if (ptyId) {
    for (const ws of state.workspaces) {
      const found = findSurfaceByPtyId(ws.rootPane, ptyId);
      if (found) return { workspaceId: ws.id, surfaceId: found.surfaceId };
    }
    return null;
  }
  const targetWsId = workspaceIdHint ?? state.activeWorkspaceId;
  if (!targetWsId) return null;
  const ws = state.workspaces.find((w) => w.id === targetWsId);
  if (!ws) return null;
  // Best-effort active surface lookup. If no active leaf, the notification
  // is still recorded at the workspace level with no surfaceId.
  const findActiveLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findActiveLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findActiveLeaf(ws.rootPane);
  const surfaceId = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId)?.id;
  return { workspaceId: ws.id, surfaceId };
}

export function useNotificationListener() {
  useEffect(() => {
    const unsubNotif = window.electronAPI.notification.onNew((ptyId, data) => {
      const state = useStore.getState();
      const target = resolveNotificationTarget(state, ptyId, data.workspaceId);
      if (!target) return;

      // Skip notification entirely when the user is already looking at the
      // originating surface — the badge would only count something they
      // already saw, and a transient in-app toast over the active terminal
      // is pure noise. OS toast is still gated by window focus inside
      // ToastManager, so this only affects the in-app surfaces.
      if (
        ptyId &&
        target.workspaceId === state.activeWorkspaceId &&
        target.surfaceId &&
        isActivePtySurface(
          state.workspaces.find((w) => w.id === target.workspaceId)!,
          ptyId,
        )
      ) {
        return;
      }

      state.addNotification({
        surfaceId: target.surfaceId,
        workspaceId: target.workspaceId,
        type: data.type as NotificationType,
        title: data.title,
        body: data.body,
      });
      // Inline in-app toast fallback — shown in ToastContainer regardless of
      // window focus. The OS-level toast in ToastManager only fires when
      // unfocused, so this guarantees a visible signal in either state.
      // Gated by `toastEnabled` so the existing user preference still wins;
      // without this gate, disabling toasts in settings would only suppress
      // OS-level toasts and leave the in-app overlay popping anyway.
      if (state.toastEnabled) {
        state.pushToast({ message: data.title, level: data.type === 'error' ? 'error' : data.type === 'warning' ? 'warn' : 'info' });
      }
      // Play sound if enabled (throttled)
      if (state.notificationSoundEnabled) {
        const now = Date.now();
        const key = data.type;
        if (!lastSoundTime[key] || now - lastSoundTime[key] > SOUND_THROTTLE_MS) {
          lastSoundTime[key] = now;
          playNotificationSound(data.type as NotificationType);
        }
      }
    });

    const unsubCwd = window.electronAPI.notification.onCwdChanged((ptyId, cwd) => {
      const state = useStore.getState();
      for (const ws of state.workspaces) {
        const found = findSurfaceByPtyId(ws.rootPane, ptyId);
        if (found) {
          state.updateWorkspaceMetadata(ws.id, { cwd });
          break;
        }
      }
    });

    const unsubMeta = window.electronAPI.metadata.onUpdate((payload) => {
      const state = useStore.getState();
      // Discriminator: ptyId routes to its workspace; workspaceId is direct;
      // neither means "active workspace" (e.g. meta.setStatus from a CLI).
      const { ptyId, workspaceId: payloadWsId, ...rest } = payload;

      const applyToWorkspace = (wsId: string, restrictCwd: boolean) => {
        const data: Partial<typeof rest> = restrictCwd ? (() => {
          const { cwd: _cwd, ...withoutCwd } = rest;
          return withoutCwd;
        })() : rest;
        if (Object.keys(data).length > 0) {
          state.updateWorkspaceMetadata(wsId, data as Parameters<typeof state.updateWorkspaceMetadata>[1]);
        }
      };

      if (ptyId) {
        for (const ws of state.workspaces) {
          const found = findSurfaceByPtyId(ws.rootPane, ptyId);
          if (found) {
            // Only update CWD from the active pane's active surface to prevent
            // stale PTYs from overwriting the current directory.
            applyToWorkspace(ws.id, !isActivePtySurface(ws, ptyId));
            break;
          }
        }
        return;
      }

      const targetWsId = payloadWsId ?? state.activeWorkspaceId;
      if (targetWsId) {
        applyToWorkspace(targetWsId, false);
      }
    });

    const unsubGitBranch = window.electronAPI.notification.onGitBranchChanged((ptyId, branch) => {
      const state = useStore.getState();
      for (const ws of state.workspaces) {
        const found = findSurfaceByPtyId(ws.rootPane, ptyId);
        if (found) {
          state.updateWorkspaceMetadata(ws.id, { gitBranch: branch });
          break;
        }
      }
    });

    const unsubToken = window.electronAPI.token.onUpdate((ptyId, data) => {
      useStore.getState().updateTokenData(ptyId, data);
    });

    return () => {
      unsubNotif();
      unsubCwd();
      unsubMeta();
      unsubGitBranch();
      unsubToken();
    };
  }, []);
}
