import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../../shared/constants';

type GetWindow = () => BrowserWindow | null;

const TIMEOUT_MS = 5000;

/**
 * Sends a RPC command to the renderer via IPC and waits for the response.
 * Uses a unique requestId per call so concurrent requests don't collide.
 */
export function sendToRenderer(
  getWindow: GetWindow,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) {
      reject(new Error('BrowserWindow is not available'));
      return;
    }

    const requestId = `rpc-${randomUUID()}`;
    const responseChannel = `${IPC.RPC_RESPONSE}:${requestId}`;

    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(responseChannel);
      reject(new Error(`RPC timeout: ${method} (${TIMEOUT_MS}ms)`));
    }, TIMEOUT_MS);

    ipcMain.once(responseChannel, (_event, result: unknown) => {
      clearTimeout(timer);
      resolve(result);
    });

    win.webContents.send(IPC.RPC_COMMAND, requestId, method, params);
  });
}
