import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

export function registerPaneRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * pane.list — returns all panes (leaf nodes) of the current workspace
   */
  router.register('pane.list', (_params) =>
    sendToRenderer(getWindow, 'pane.list'),
  );

  /**
   * pane.focus — focuses a specific pane
   * params: { id: string }
   */
  router.register('pane.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('pane.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'pane.focus', { id: params['id'] });
  });

  /**
   * pane.split — splits the active pane
   * params: { direction: 'horizontal' | 'vertical' }
   */
  router.register('pane.split', (params) => {
    const direction = params['direction'];
    if (direction !== 'horizontal' && direction !== 'vertical') {
      return Promise.reject(
        new Error('pane.split: "direction" must be "horizontal" or "vertical"'),
      );
    }
    return sendToRenderer(getWindow, 'pane.split', { direction });
  });
}
