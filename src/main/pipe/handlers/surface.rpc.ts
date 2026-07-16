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
   * surface.new — creates a new surface in the active pane of a workspace.
   * params: { workspaceId?, shell?, cwd? } — omitted workspaceId ⇒ active ws.
   *
   * Earlier this dropped params entirely, so an explicit workspaceId/shell/cwd
   * was silently ignored and every surface opened in the on-screen workspace
   * (the #236 family of bugs). Forward them so a multi-agent caller can open a
   * terminal in ITS OWN workspace; the renderer fails closed on an unknown
   * explicit workspaceId.
   */
  router.register('surface.new', (params, ctx) => {
    let workspaceId = params['workspaceId'];
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      return Promise.reject(new Error('surface.new: "workspaceId" must be a string if provided'));
    }
    // BYOB P4: same commander confinement as pane.split — explicit mismatch
    // refused, omitted pinned to the commander's own workspace.
    if (ctx?.commanderWorkspace) {
      if (workspaceId !== undefined && workspaceId !== ctx.commanderWorkspace) {
        return Promise.reject(
          new Error('surface.new: workspace is outside the commander\'s workspace'),
        );
      }
      workspaceId = ctx.commanderWorkspace;
    }
    return sendToRenderer(getWindow, 'surface.new', {
      ...(workspaceId !== undefined && { workspaceId }),
      ...(typeof params['shell'] === 'string' && { shell: params['shell'] }),
      ...(typeof params['cwd'] === 'string' && { cwd: params['cwd'] }),
    });
  });

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
