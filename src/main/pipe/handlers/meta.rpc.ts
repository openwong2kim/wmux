import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { IPC } from '../../../shared/constants';

type GetWindow = () => BrowserWindow | null;

/**
 * Sub-channel names embedded in the METADATA_UPDATE IPC message.
 * The renderer's useNotificationListener (or a dedicated metadata listener)
 * discriminates on the `kind` field.
 */
type MetaUpdateKind = 'status' | 'progress';

interface MetaStatusPayload {
  kind: 'status';
  text: string;
}

interface MetaProgressPayload {
  kind: 'progress';
  value: number;
}

type MetaPayload = MetaStatusPayload | MetaProgressPayload;

function sendMeta(getWindow: GetWindow, payload: MetaPayload): Promise<{ ok: boolean }> {
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('meta: BrowserWindow is not available'));
  }
  win.webContents.send(IPC.METADATA_UPDATE, payload);
  return Promise.resolve({ ok: true });
}

export function registerMetaRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * meta.setStatus — sets an arbitrary status text string in the renderer.
   * params: { text: string }
   */
  router.register('meta.setStatus', (params) => {
    if (typeof params['text'] !== 'string') {
      throw new Error('meta.setStatus: missing required param "text"');
    }
    return sendMeta(getWindow, { kind: 'status', text: params['text'] });
  });

  /**
   * meta.setProgress — sets a progress value (0–100) in the renderer.
   * params: { value: number }
   * Values outside 0–100 are clamped.
   */
  router.register('meta.setProgress', (params) => {
    if (typeof params['value'] !== 'number') {
      throw new Error('meta.setProgress: missing required param "value" (number)');
    }
    const value = Math.min(100, Math.max(0, params['value']));
    return sendMeta(getWindow, { kind: 'progress', value });
  });
}
