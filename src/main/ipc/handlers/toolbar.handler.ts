import { ipcMain, dialog, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
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

/** Where the folder picker last chose, this run: Electron opens a dialog with
 *  no `defaultPath` in Downloads and no longer lets the OS restore it. */
let lastPickedFolder: string | undefined;

export function registerToolbarHandlers(): () => void {
  ipcMain.removeHandler(IPC.GIT_STATUS);
  ipcMain.handle(IPC.GIT_STATUS, wrapHandler(IPC.GIT_STATUS, async (_event: Electron.IpcMainInvokeEvent, cwd: string): Promise<string> => {
    const resolved = await resolveAccessiblePath(cwd);
    if (!resolved) return '';
    return gitStatusPorcelain(resolved);
  }));

  ipcMain.removeHandler(IPC.DIALOG_PICK_FOLDER);
  ipcMain.handle(IPC.DIALOG_PICK_FOLDER, wrapHandler(IPC.DIALOG_PICK_FOLDER, async (event: Electron.IpcMainInvokeEvent): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      properties: ['openDirectory'] as Array<'openDirectory'>,
      ...(lastPickedFolder ? { defaultPath: path.dirname(lastPickedFolder) } : {}),
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    if (result.filePaths[0]) lastPickedFolder = result.filePaths[0];
    return result.filePaths;
  }));

  return () => {
    ipcMain.removeHandler(IPC.GIT_STATUS);
    ipcMain.removeHandler(IPC.DIALOG_PICK_FOLDER);
  };
}
