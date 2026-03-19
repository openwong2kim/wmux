import { ipcMain, clipboard } from 'electron';
import { IPC } from '../../../shared/constants';

export function registerClipboardHandlers(): void {
  // Remove any previously registered handlers before re-registering.
  // ipcMain.handle() throws if the same channel is registered twice (e.g.
  // during dev HMR reloads), which silently kills clipboard IPC.
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ);

  ipcMain.handle(IPC.CLIPBOARD_WRITE, (_event, text: string) => {
    if (typeof text !== 'string') return;
    if (text.length > 1_000_000) return; // 1MB limit
    clipboard.writeText(text);
  });

  ipcMain.handle(IPC.CLIPBOARD_READ, () => {
    return clipboard.readText();
  });
}
