import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { MetadataCollector } from '../../metadata/MetadataCollector';
import { PTYManager } from '../../pty/PTYManager';

const collector = new MetadataCollector();

// Track CWD per ptyId (updated via OSC 7 or polling)
const cwdMap = new Map<string, string>();

export function registerMetadataHandlers(
  ptyManager: PTYManager,
  getWindow: () => BrowserWindow | null,
): () => void {
  // Handle metadata request from renderer
  ipcMain.handle(IPC.METADATA_REQUEST, async (_event, ptyId: string) => {
    const cwd = cwdMap.get(ptyId);
    return collector.collect(cwd);
  });

  // Listen for CWD changes from PTYBridge (via OscParser)
  ipcMain.on(IPC.CWD_CHANGED, (_event, ptyId: string, cwd: string) => {
    cwdMap.set(ptyId, cwd);
  });

  // Periodic metadata polling (every 5 seconds)
  const pollingInterval = setInterval(async () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;

    for (const [ptyId] of cwdMap) {
      const instance = ptyManager.get(ptyId);
      if (!instance) {
        cwdMap.delete(ptyId);
        continue;
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
    ipcMain.removeAllListeners(IPC.CWD_CHANGED);
  };
}

export function updateCwd(ptyId: string, cwd: string): void {
  cwdMap.set(ptyId, cwd);
}
