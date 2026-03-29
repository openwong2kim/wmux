import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';

export function registerSessionHandlers(): () => void {
  // Session save/load — no-op (daemon holds all state in memory)
  ipcMain.removeHandler(IPC.SESSION_SAVE);
  ipcMain.handle(IPC.SESSION_SAVE, () => ({ success: true }));

  ipcMain.removeHandler(IPC.SESSION_LOAD);
  ipcMain.handle(IPC.SESSION_LOAD, () => null);

  // Scrollback persistence removed — daemon RingBuffer is the source of truth
  ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
  ipcMain.handle(IPC.SCROLLBACK_DUMP, () => ({ success: true }));

  ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  ipcMain.handle(IPC.SCROLLBACK_LOAD, () => null);

  return () => {
    ipcMain.removeHandler(IPC.SESSION_SAVE);
    ipcMain.removeHandler(IPC.SESSION_LOAD);
    ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
    ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  };
}
