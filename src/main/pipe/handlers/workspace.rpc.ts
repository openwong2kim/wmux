import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

export function registerWorkspaceRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * workspace.list — returns all workspaces as {id, name}[]
   */
  router.register('workspace.list', (_params) =>
    sendToRenderer(getWindow, 'workspace.list'),
  );

  /**
   * workspace.new — creates a new workspace
   * params: { name?: string }
   */
  router.register('workspace.new', (params) => {
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    return sendToRenderer(getWindow, 'workspace.new', name !== undefined ? { name } : {});
  });

  /**
   * workspace.focus — sets the active workspace
   * params: { id: string }
   */
  router.register('workspace.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('workspace.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'workspace.focus', { id: params['id'] });
  });

  /**
   * workspace.close — removes a workspace
   * params: { id: string }
   */
  router.register('workspace.close', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('workspace.close: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'workspace.close', { id: params['id'] });
  });

  /**
   * workspace.current — returns the currently active workspace {id, name}
   */
  router.register('workspace.current', (_params) =>
    sendToRenderer(getWindow, 'workspace.current'),
  );
}
