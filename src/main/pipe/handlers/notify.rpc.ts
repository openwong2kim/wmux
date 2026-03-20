import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { NotificationType } from '../../../shared/types';
import { IPC } from '../../../shared/constants';
import { ToastManager } from '../../notification/ToastManager';

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
   *   title:   string
   *   body:    string
   *   type?:   'info' | 'warning' | 'error' | 'agent'  (default: 'info')
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

    const win = getWindow();
    if (win && !win.isDestroyed()) {
      // Push notification to the renderer notification store
      win.webContents.send(IPC.NOTIFICATION, { title, body, type });
    }

    // Show OS-level toast (only when window is not focused)
    toastManager.show(title, body);

    return Promise.resolve({ delivered: true, type });
  });
}
