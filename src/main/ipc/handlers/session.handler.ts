import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { SessionManager } from '../../session/SessionManager';
import type { SessionData } from '../../../shared/types';

const sessionManager = new SessionManager();

export function registerSessionHandlers(): void {
  ipcMain.handle(IPC.SESSION_SAVE, (_event, data: SessionData) => {
    sessionManager.save(data);
    return { success: true };
  });

  ipcMain.handle(IPC.SESSION_LOAD, () => {
    return sessionManager.load();
  });
}
