import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import { IPC } from '../../../shared/constants';
import type { MetadataUpdatePayload } from '../../../shared/types';
import { MetadataCollector } from '../../metadata/MetadataCollector';
import { PTYManager } from '../../pty/PTYManager';
import { wrapHandler } from '../wrapHandler';

/**
 * Single source for IPC.METADATA_UPDATE outgoing messages. All metadata-like
 * channels (this handler's CWD/git polling, PTYBridge's agent status events,
 * meta.rpc's status/progress RPCs) send through `MetadataUpdatePayload` so
 * the preload + renderer contract has exactly one shape.
 */
export function broadcastMetadataUpdate(
  window: BrowserWindow | null,
  payload: MetadataUpdatePayload,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.METADATA_UPDATE, payload);
}

const collector = new MetadataCollector();

// Track CWD per ptyId (updated via OSC 7, prompt detection, or initial registration)
const cwdMap = new Map<string, string>();

// Track git branch per ptyId (updated via OSC 7727 shell integration hook)
const branchMap = new Map<string, string>();

export function registerMetadataHandlers(
  ptyManager: PTYManager,
  getWindow: () => BrowserWindow | null,
): () => void {
  // Handle metadata request from renderer
  ipcMain.removeHandler(IPC.METADATA_REQUEST);
  ipcMain.handle(IPC.METADATA_REQUEST, wrapHandler(IPC.METADATA_REQUEST, async (_event: Electron.IpcMainInvokeEvent, ptyId: string) => {
    const cwd = cwdMap.get(ptyId);
    const shellBranch = branchMap.get(ptyId);
    return collector.collect(cwd, shellBranch);
  }));

  // Periodic metadata polling (every 5 seconds)
  const pollingInterval = setInterval(async () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) return;

    for (const [ptyId] of cwdMap) {
      const instance = ptyManager.get(ptyId);
      if (!instance) {
        cwdMap.delete(ptyId);
        branchMap.delete(ptyId);
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
        // If shell integration provided a branch via OSC 7727, skip git exec polling
        const shellBranch = branchMap.get(ptyId);
        const metadata = await collector.collect(cwd, shellBranch);
        broadcastMetadataUpdate(win, { ptyId, ...metadata });
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

export function updateBranch(ptyId: string, branch: string): void {
  branchMap.set(ptyId, branch);
}

export function removeBranch(ptyId: string): void {
  branchMap.delete(ptyId);
}

export function getCwd(ptyId: string): string | undefined {
  return cwdMap.get(ptyId);
}

export function getBranch(ptyId: string): string | undefined {
  return branchMap.get(ptyId);
}
