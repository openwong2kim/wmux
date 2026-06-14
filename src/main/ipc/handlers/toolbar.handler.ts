import { ipcMain, dialog, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { resolveAccessiblePath } from './fs.handler';

/** Run `git status --porcelain` in `cwd`. Returns raw stdout, '' on any error
 *  (not a repo, git missing, blocked path). Renderer parses with
 *  shared/gitStatus.parsePorcelain. */
function gitStatusPorcelain(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain'],
      { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, // generous for porcelain; real repos are well under this
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
}

export function registerToolbarHandlers(): () => void {
  ipcMain.removeHandler(IPC.GIT_STATUS);
  ipcMain.handle(IPC.GIT_STATUS, wrapHandler(IPC.GIT_STATUS, async (_event: Electron.IpcMainInvokeEvent, cwd: string): Promise<string> => {
    const resolved = await resolveAccessiblePath(cwd);
    if (!resolved) return '';
    return gitStatusPorcelain(resolved);
  }));

  ipcMain.removeHandler(IPC.DIALOG_PICK_FILE);
  ipcMain.handle(IPC.DIALOG_PICK_FILE, wrapHandler(IPC.DIALOG_PICK_FILE, async (event: Electron.IpcMainInvokeEvent): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    return result.filePaths;
  }));

  return () => {
    ipcMain.removeHandler(IPC.GIT_STATUS);
    ipcMain.removeHandler(IPC.DIALOG_PICK_FILE);
  };
}
