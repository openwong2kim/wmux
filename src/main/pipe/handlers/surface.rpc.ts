import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

export function registerSurfaceRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * surface.list — returns surfaces of a workspace.
   * params: { workspaceId? } — omitted ⇒ active workspace.
   *
   * The renderer handler honors `workspaceId` (useRpcBridge.ts), but earlier
   * the main-side router dropped params entirely, silently scoping every
   * caller to the active workspace. Forward params unchanged so MCP callers
   * can target their own workspace explicitly (and enforcement layers above
   * can rely on the parameter being respected).
   */
  router.register('surface.list', (params) =>
    sendToRenderer(getWindow, 'surface.list', params),
  );

  /**
   * surface.new — creates a new surface in the active pane
   */
  router.register('surface.new', (_params) =>
    sendToRenderer(getWindow, 'surface.new'),
  );

  /**
   * surface.focus — focuses a specific surface
   * params: { id: string }
   */
  router.register('surface.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('surface.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'surface.focus', { id: params['id'] });
  });

  /**
   * surface.close — closes a specific surface
   * params: { id: string }
   */
  router.register('surface.close', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('surface.close: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'surface.close', { id: params['id'] });
  });
}
