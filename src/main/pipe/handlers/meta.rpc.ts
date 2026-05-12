import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { MetadataUpdatePayload } from '../../../shared/types';
import { broadcastMetadataUpdate } from '../../ipc/handlers/metadata.handler';

type GetWindow = () => BrowserWindow | null;

/**
 * meta.setStatus / meta.setProgress write through the unified
 * MetadataUpdatePayload shape on IPC.METADATA_UPDATE. The previous
 * discriminated `{kind, ...}` payload conflicted with the (ptyId, data)
 * shape sent by metadata.handler.ts, which broke preload's listener for one
 * of the two paths. Both paths now agree on a single shape.
 *
 * Without ptyId/workspaceId, the renderer applies the update to the active
 * workspace (status/progress are workspace-level fields).
 */
function sendMeta(getWindow: GetWindow, payload: MetadataUpdatePayload): Promise<{ ok: boolean }> {
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('meta: BrowserWindow is not available'));
  }
  broadcastMetadataUpdate(win, payload);
  return Promise.resolve({ ok: true });
}

export function registerMetaRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * meta.setStatus — sets an arbitrary status text string on the active
   * workspace.
   * params: { text: string, workspaceId?: string }
   */
  router.register('meta.setStatus', (params) => {
    if (typeof params['text'] !== 'string') {
      throw new Error('meta.setStatus: missing required param "text"');
    }
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    return sendMeta(getWindow, { status: params['text'], workspaceId });
  });

  /**
   * meta.setProgress — sets a progress value (0–100) on the active workspace.
   * params: { value: number, workspaceId?: string }
   * Values outside 0–100 are clamped.
   */
  router.register('meta.setProgress', (params) => {
    if (typeof params['value'] !== 'number') {
      throw new Error('meta.setProgress: missing required param "value" (number)');
    }
    const value = Math.min(100, Math.max(0, params['value']));
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    return sendMeta(getWindow, { progress: value, workspaceId });
  });
}
