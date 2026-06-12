import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { NotificationType } from '../../../shared/types';
import { ToastManager } from '../../notification/ToastManager';
import { sendNotification } from '../../notification/sendNotification';

type GetWindow = () => BrowserWindow | null;

const VALID_TYPES = new Set<NotificationType>(['info', 'warning', 'error', 'agent']);

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && VALID_TYPES.has(value as NotificationType);
}

export const toastManager = new ToastManager();

export function registerNotifyRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * notify — delivers a notification to the renderer UI and, when the app is
   * not focused, also shows a Windows Toast notification.
   *
   * params: {
   *   title:        string
   *   body:         string
   *   type?:        'info' | 'warning' | 'error' | 'agent'  (default: 'info')
   *   workspaceId?: string  — optional. When omitted, the renderer applies
   *                           to the active workspace (backward compat for
   *                           CLI `wmux notify` callers; MCP clients that
   *                           know their workspace via mcp.claimWorkspace
   *                           SHOULD send it for precise routing)
   * }
   */
  router.register('notify', (params) => {
    if (typeof params['title'] !== 'string' || params['title'].length === 0) {
      throw new Error('notify: missing required param "title"');
    }
    if (typeof params['body'] !== 'string') {
      throw new Error('notify: missing required param "body"');
    }

    const title = params['title'];
    const body = params['body'];
    const type: NotificationType = isNotificationType(params['type'])
      ? params['type']
      : 'info';
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    // ptyId is null here — this RPC originates outside any PTY. The renderer
    // resolves a surface via `workspaceId` (if provided) or falls back to
    // the active workspace.
    sendNotification(getWindow(), null, { title, body, type, workspaceId });

    // Show OS-level toast (only when window is not focused). workspaceId
    // (when the caller sent one) makes the toast clickable: click jumps to
    // that workspace. No ptyId exists for this RPC — see comment above.
    toastManager.show(title, body, { workspaceId });

    return Promise.resolve({ delivered: true, type });
  });
}
