import type { BrowserWindow } from 'electron';
import type { NotificationType } from '../../shared/types';
import { IPC } from '../../shared/constants';

export interface NotificationPayload {
  title: string;
  body: string;
  type: NotificationType;
  /**
   * When ptyId is null, the notification did not originate from a specific
   * surface (e.g. external MCP `notify` RPC, app-level alerts). The renderer
   * uses workspaceId to resolve the active surface, or surfaces a
   * workspace-scoped notification with surfaceId left undefined.
   */
  workspaceId?: string;
}

/**
 * Module-level utility for sending notifications from main to renderer.
 *
 * Previously, four call sites in PTYBridge plus one in notify.rpc.ts inlined
 * their own `webContents.send(IPC.NOTIFICATION, ...)` calls with subtly
 * different argument shapes. notify.rpc was particularly broken: it sent
 * `(channel, payloadObject)` while preload's `notification.onNew` listener
 * expects `(channel, ptyId, payload)`, so the payload silently arrived as
 * `ptyId` and the actual data was undefined.
 *
 * Centralizing here gives one place to define the IPC contract:
 *   webContents.send(IPC.NOTIFICATION, ptyId: string | null, payload)
 *
 * Renderer's useNotificationListener consults `ptyId` to find the originating
 * surface; if null, it falls back to `payload.workspaceId` and resolves the
 * active surface from the store.
 */
export function sendNotification(
  window: BrowserWindow | null,
  ptyId: string | null,
  payload: NotificationPayload,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.NOTIFICATION, ptyId, payload);
}
