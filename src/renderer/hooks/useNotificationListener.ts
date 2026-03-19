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
          state.updateWorkspaceMetadata(ws.id, data);
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
