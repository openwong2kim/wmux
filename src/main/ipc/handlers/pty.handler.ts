import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PTYManager } from '../../pty/PTYManager';
import { PTYBridge } from '../../pty/PTYBridge';
import { IPC } from '../../../shared/constants';
import { updateCwd } from './metadata.handler';

/**
 * Allowed shell basenames (case-insensitive on Windows).
 * Only these executables may be spawned via IPC.
 */
const ALLOWED_SHELLS = new Set([
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'bash.exe',
  'wsl.exe',
  'git-bash.exe',
  'sh.exe',
]);

function isAllowedShell(shell: string): boolean {
  const basename = path.basename(shell).toLowerCase();
  return ALLOWED_SHELLS.has(basename);
}

export function registerPTYHandlers(ptyManager: PTYManager, ptyBridge: PTYBridge): () => void {
  ipcMain.removeHandler(IPC.PTY_CREATE);
  ipcMain.handle(IPC.PTY_CREATE, (_event, options?: { shell?: string; cwd?: string; cols?: number; rows?: number }) => {
    if (options?.shell !== undefined && !isAllowedShell(options.shell)) {
      throw new Error(`PTY_CREATE: shell not allowed: ${options.shell}`);
    }

    // Validate workDir to block UNC paths and non-existent directories
    let safeCwd: string | undefined;
    if (options?.cwd) {
      const resolved = path.resolve(options.cwd);
      // Block UNC paths (e.g. \\server\share)
      if (!resolved.startsWith('\\\\') && fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          safeCwd = resolved;
        }
      }
    }

    const effectiveCwd = safeCwd ?? undefined;
    const instance = ptyManager.create(effectiveCwd !== undefined ? { ...options, cwd: effectiveCwd } : { ...options, cwd: undefined });
    ptyBridge.setupDataForwarding(instance.id);
    // Return the actual cwd so renderer can track it from the start
    const actualCwd = effectiveCwd || require('os').homedir();
    // Register initial CWD in cwdMap so metadata polling works from the start
    updateCwd(instance.id, actualCwd);
    return { id: instance.id, shell: instance.shell, cwd: actualCwd };
  });

  // Use ipcMain.on (fire-and-forget) instead of handle for lower latency
  const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
    // 세션 복원 시 이전 ptyId가 남아있을 수 있음 — 조용히 무시
    if (!ptyManager.get(id)) return;
    if (typeof data !== 'string') return;
    if (data.length > 100_000) return; // prevent mega-writes
    ptyManager.write(id, data);
  };
  ipcMain.removeAllListeners(IPC.PTY_WRITE);
  ipcMain.on(IPC.PTY_WRITE, onPtyWrite);

  ipcMain.removeHandler(IPC.PTY_RESIZE);
  ipcMain.handle(IPC.PTY_RESIZE, (_event, id: string, cols: number, rows: number) => {
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
    }
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.removeHandler(IPC.PTY_DISPOSE);
  ipcMain.handle(IPC.PTY_DISPOSE, (_event, id: string) => {
    ptyManager.dispose(id);
  });

  // Crash recovery: renderer can query active PTY instances after reload
  ipcMain.removeHandler(IPC.PTY_LIST);
  ipcMain.handle(IPC.PTY_LIST, () => {
    return ptyManager.getActiveInstances();
  });

  // Crash recovery: renderer can re-attach to an existing PTY after reload.
  // Data forwarding is already active (PTYBridge listeners survive reload since
  // they reference getWindow() which returns the same BrowserWindow), so this
  // just confirms the PTY is alive and returns its info.
  ipcMain.removeHandler(IPC.PTY_RECONNECT);
  ipcMain.handle(IPC.PTY_RECONNECT, (_event, id: string) => {
    const instance = ptyManager.get(id);
    if (!instance) {
      return { success: false, error: 'PTY not found' };
    }
    return { success: true, id: instance.id, shell: instance.shell };
  });

  return () => {
    ipcMain.removeHandler(IPC.PTY_CREATE);
    ipcMain.removeAllListeners(IPC.PTY_WRITE);
    ipcMain.removeHandler(IPC.PTY_RESIZE);
    ipcMain.removeHandler(IPC.PTY_DISPOSE);
    ipcMain.removeHandler(IPC.PTY_LIST);
    ipcMain.removeHandler(IPC.PTY_RECONNECT);
  };
}
