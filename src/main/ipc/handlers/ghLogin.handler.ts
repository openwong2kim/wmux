// One-step GitHub connect — ghLogin:start / ghLogin:cancel and the
// ghLogin:event push. Renderer-only IPC. The login itself is a process-wide
// singleton: a handler swap (daemon reconnect) detaches only the IPC and the
// event sink, never a sign-in the user is in the middle of.
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import type { GhLoginStartResult } from '../../../shared/ghDeviceLogin';
import { wrapHandler } from '../wrapHandler';
import { ghLogin, type GhLogin } from '../../github/ghLogin';

export function registerGhLoginHandlers(
  getWindow: () => BrowserWindow | null,
  login: GhLogin = ghLogin,
): () => void {
  const off = login.onEvent((event) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.GH_LOGIN_EVENT, event);
  });

  ipcMain.removeHandler(IPC.GH_LOGIN_START);
  ipcMain.handle(
    IPC.GH_LOGIN_START,
    wrapHandler(IPC.GH_LOGIN_START, (): Promise<GhLoginStartResult> => login.start()),
  );

  ipcMain.removeHandler(IPC.GH_LOGIN_CANCEL);
  ipcMain.handle(
    IPC.GH_LOGIN_CANCEL,
    wrapHandler(IPC.GH_LOGIN_CANCEL, (): void => login.cancel()),
  );

  return () => {
    off();
    ipcMain.removeHandler(IPC.GH_LOGIN_START);
    ipcMain.removeHandler(IPC.GH_LOGIN_CANCEL);
  };
}
