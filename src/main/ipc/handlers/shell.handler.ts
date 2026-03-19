import { ipcMain } from 'electron';
import { ShellDetector } from '../../pty/ShellDetector';
import { IPC } from '../../../shared/constants';

export function registerShellHandlers(): void {
  const detector = new ShellDetector();

  ipcMain.handle(IPC.SHELL_LIST, () => {
    return detector.detect();
  });
}
