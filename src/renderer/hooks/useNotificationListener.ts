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

export function useNotificationListener() {
  useEffect(() => {
    const unsubNotif = window.electronAPI.notification.onNew((ptyId, data) => {
      const state = useStore.getState();
      // Find which workspace/surface this ptyId belongs to
      for (const ws of state.workspaces) {
        const found = findSurfaceByPtyId(ws.rootPane, ptyId);
        if (found) {
          state.addNotification({
            surfaceId: found.surfaceId,
            workspaceId: ws.id,
            type: data.type as NotificationType,
            title: data.title,
            body: data.body,
          });
          // Play sound if enabled (throttled)
          if (useStore.getState().notificationSoundEnabled) {
            const now = Date.now();
            const key = data.type;
            if (!lastSoundTime[key] || now - lastSoundTime[key] > SOUND_THROTTLE_MS) {
              lastSoundTime[key] = now;
              playNotificationSound(data.type as NotificationType);
            }
          }
          break;
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

    const unsubMeta = window.electronAPI.metadata.onUpdate((ptyId, data) => {
      const state = useStore.getState();
      for (const ws of state.workspaces) {
        const found = findSurfaceByPtyId(ws.rootPane, ptyId);
        if (found) {
          // Only update CWD from the active pane's active surface to prevent
          // stale PTYs from overwriting the current directory
          const isActiveSurface = isActivePtySurface(ws, ptyId);
          if (isActiveSurface) {
            state.updateWorkspaceMetadata(ws.id, data);
          } else {
            // For non-active surfaces, update metadata but exclude cwd
            const { cwd: _cwd, ...rest } = data;
            if (Object.keys(rest).length > 0) {
              state.updateWorkspaceMetadata(ws.id, rest);
            }
          }
          break;
        }
      }
    });

    return () => {
      unsubNotif();
      unsubCwd();
      unsubMeta();
    };
  }, []);
}
