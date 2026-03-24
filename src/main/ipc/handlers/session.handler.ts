import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../../shared/constants';
import { SessionManager } from '../../session/SessionManager';
import type { SessionData } from '../../../shared/types';

const sessionManager = new SessionManager();

export function registerSessionHandlers(): () => void {
  ipcMain.removeHandler(IPC.SESSION_SAVE);
  ipcMain.handle(IPC.SESSION_SAVE, (_event, data: SessionData) => {
    sessionManager.save(data);
    return { success: true };
  });

  ipcMain.removeHandler(IPC.SESSION_LOAD);
  ipcMain.handle(IPC.SESSION_LOAD, () => {
    return sessionManager.load();
  });

  // scrollback:dump — write terminal buffer to file
  ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
  ipcMain.handle(IPC.SCROLLBACK_DUMP, (_event, surfaceId: string, content: string) => {
    // Validate surfaceId (alphanumeric + hyphens only, prevent path traversal)
    if (!/^[a-zA-Z0-9-]+$/.test(surfaceId)) return { success: false };
    const dir = path.join(app.getPath('userData'), 'scrollback');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${surfaceId}.txt`);
    // Cap at 5MB to prevent disk bloat
    const capped = content.length > 5 * 1024 * 1024 ? content.slice(-5 * 1024 * 1024) : content;
    fs.writeFileSync(filePath, capped, 'utf-8');
    return { success: true };
  });

  // scrollback:load — read terminal buffer from file
  ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  ipcMain.handle(IPC.SCROLLBACK_LOAD, (_event, surfaceId: string) => {
    if (!/^[a-zA-Z0-9-]+$/.test(surfaceId)) return null;
    const filePath = path.join(app.getPath('userData'), 'scrollback', `${surfaceId}.txt`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      // Don't delete scrollback files here — they are overwritten by the
      // next periodic dump cycle (every 5s).  Deleting on load created a
      // window where a crash between load and the next dump would lose
      // all scrollback data because session.json still referenced the
      // (now-deleted) file.
      return content;
    } catch {
      return null;
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.SESSION_SAVE);
    ipcMain.removeHandler(IPC.SESSION_LOAD);
    ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
    ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  };
}
