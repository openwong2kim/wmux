import { ipcMain, clipboard, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../../shared/constants';

// Track the last paste temp file so we can clean it up on the next paste
let lastPasteFile: string | null = null;

export function registerClipboardHandlers(): void {
  // Remove any previously registered handlers before re-registering.
  // ipcMain.handle() throws if the same channel is registered twice (e.g.
  // during dev HMR reloads), which silently kills clipboard IPC.
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ_IMAGE);
  ipcMain.removeHandler(IPC.CLIPBOARD_HAS_IMAGE);

  ipcMain.handle(IPC.CLIPBOARD_WRITE, (_event, text: string) => {
    if (typeof text !== 'string') return;
    if (text.length > 1_000_000) return; // 1MB limit
    clipboard.writeText(text);
  });

  ipcMain.handle(IPC.CLIPBOARD_READ, () => {
    return clipboard.readText();
  });

  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    // Clean up previous paste file to avoid accumulating temp files
    if (lastPasteFile) {
      try { fs.unlinkSync(lastPasteFile); } catch { /* already deleted */ }
    }

    const tempDir = app.getPath('temp');
    const filePath = path.join(tempDir, `wmux-paste-${Date.now()}.png`);
    fs.writeFileSync(filePath, image.toPNG());
    lastPasteFile = filePath;
    return filePath;
  });

  ipcMain.handle(IPC.CLIPBOARD_HAS_IMAGE, () => {
    return clipboard.availableFormats().some(f => f.startsWith('image/'));
  });
}
