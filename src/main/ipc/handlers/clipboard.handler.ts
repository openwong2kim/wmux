import { ipcMain, clipboard, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';

// Paste temp files must outlive the next paste: consumers (e.g. Claude Code)
// read the pasted file path later, so deleting the previous file on each paste
// destroys earlier images when multiple are pasted (issue #201). Instead,
// sweep stale files older than MAX_PASTE_FILE_AGE_MS once at startup.
const MAX_PASTE_FILE_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupStalePasteFiles(): void {
  const tempDir = app.getPath('temp');
  let entries: string[];
  try {
    entries = fs.readdirSync(tempDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_PASTE_FILE_AGE_MS;
  for (const name of entries) {
    if (!name.startsWith('wmux-paste-') || !name.endsWith('.png')) continue;
    const filePath = path.join(tempDir, name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch { /* file vanished or locked; skip */ }
  }
}

export function registerClipboardHandlers(): void {
  cleanupStalePasteFiles();

  // Remove any previously registered handlers before re-registering.
  // ipcMain.handle() throws if the same channel is registered twice (e.g.
  // during dev HMR reloads), which silently kills clipboard IPC.
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ_IMAGE);
  ipcMain.removeHandler(IPC.CLIPBOARD_HAS_IMAGE);

  ipcMain.handle(IPC.CLIPBOARD_WRITE, wrapHandler(IPC.CLIPBOARD_WRITE, (_event: Electron.IpcMainInvokeEvent, text: string) => {
    // Surface validation failures so renderer can react instead of silently
    // showing "copied" toasts when nothing actually reached the clipboard.
    if (typeof text !== 'string') {
      throw new Error('CLIPBOARD_INVALID_TYPE');
    }
    if (text.length > 1_000_000) {
      throw new Error('CLIPBOARD_TOO_LARGE');
    }
    try {
      clipboard.writeText(text);
    } catch (err) {
      // Win32 clipboard can fail under lock contention with other apps —
      // surface the underlying message so renderer can retry/notify.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CLIPBOARD_WRITE_FAILED: ${msg}`);
    }
  }));

  ipcMain.handle(IPC.CLIPBOARD_READ, wrapHandler(IPC.CLIPBOARD_READ, (_event: Electron.IpcMainInvokeEvent) => {
    return clipboard.readText();
  }));

  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, wrapHandler(IPC.CLIPBOARD_READ_IMAGE, (_event: Electron.IpcMainInvokeEvent) => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    const tempDir = app.getPath('temp');
    // Date.now() alone can collide when pasting rapidly; add a random suffix
    const filePath = path.join(
      tempDir,
      `wmux-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    );
    fs.writeFileSync(filePath, image.toPNG());
    return filePath;
  }));

  ipcMain.handle(IPC.CLIPBOARD_HAS_IMAGE, wrapHandler(IPC.CLIPBOARD_HAS_IMAGE, (_event: Electron.IpcMainInvokeEvent) => {
    return clipboard.availableFormats().some(f => f.startsWith('image/'));
  }));
}
