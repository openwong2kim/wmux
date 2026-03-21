import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import { IPC } from '../../../shared/constants';
import { MetadataCollector } from '../../metadata/MetadataCollector';
import { PTYManager } from '../../pty/PTYManager';

const collector = new MetadataCollector();

// Track CWD per ptyId (updated via OSC 7, prompt detection, or initial registration)
const cwdMap = new Map<string, string>();

export function registerMetadataHandlers(
  ptyManager: PTYManager,
  getWindow: () => BrowserWindow | null,
): () => void {
  // Handle metadata request from renderer
  ipcMain.removeHandler(IPC.METADATA_REQUEST);
  ipcMain.handle(IPC.METADATA_REQUEST, async (_event, ptyId: string) => {
    const cwd = cwdMap.get(ptyId);
    return collector.collect(cwd);
  });

  // Periodic metadata polling (every 5 seconds)
  const pollingInterval = setInterval(async () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) return;

    for (const [ptyId] of cwdMap) {
      const instance = ptyManager.get(ptyId);
      if (!instance) {
        cwdMap.delete(ptyId);
        continue;
      }

      // On Linux/macOS, try reading /proc/PID/cwd for live CWD detection
      if (process.platform !== 'win32') {
        try {
          const liveCwd = await fs.promises.readlink(`/proc/${instance.process.pid}/cwd`);
          if (liveCwd && liveCwd !== cwdMap.get(ptyId)) {
            cwdMap.set(ptyId, liveCwd);
          }
        } catch { /* not available on macOS without /proc */ }
      }

      const cwd = cwdMap.get(ptyId);
      if (cwd) {
        const metadata = await collector.collect(cwd);
        win.webContents.send(IPC.METADATA_UPDATE, ptyId, metadata);
      }
    }
  }, 5000);

  // cleanup 함수 반환 — 앱 종료 시 호출
  return () => {
    clearInterval(pollingInterval);
    ipcMain.removeHandler(IPC.METADATA_REQUEST);
  };
}

export function updateCwd(ptyId: string, cwd: string): void {
  cwdMap.set(ptyId, cwd);
}

export function removeCwd(ptyId: string): void {
  cwdMap.delete(ptyId);
}
