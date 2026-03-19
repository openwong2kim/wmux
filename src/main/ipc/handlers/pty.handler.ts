import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PTYManager } from '../../pty/PTYManager';
import { PTYBridge } from '../../pty/PTYBridge';
import { IPC } from '../../../shared/constants';

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

export function registerPTYHandlers(ptyManager: PTYManager, ptyBridge: PTYBridge): void {
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

    const instance = ptyManager.create(safeCwd !== undefined ? { ...options, cwd: safeCwd } : { ...options, cwd: undefined });
    ptyBridge.setupDataForwarding(instance.id);
    return { id: instance.id, shell: instance.shell };
  });

  ipcMain.handle(IPC.PTY_WRITE, (_event, id: string, data: string) => {
    // 세션 복원 시 이전 ptyId가 남아있을 수 있음 — 조용히 무시
    if (!ptyManager.get(id)) return;
    if (typeof data !== 'string') return;
    if (data.length > 100_000) return; // prevent mega-writes
    ptyManager.write(id, data);
  });

  ipcMain.handle(IPC.PTY_RESIZE, (_event, id: string, cols: number, rows: number) => {
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
    }
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.handle(IPC.PTY_DISPOSE, (_event, id: string) => {
    ptyManager.dispose(id);
  });
}
