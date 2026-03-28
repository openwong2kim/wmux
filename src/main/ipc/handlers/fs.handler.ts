import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../../../shared/constants';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

const watchers = new Map<string, fs.FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_WATCHERS = 100;

const BLOCKED_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.config/gcloud',
  '.azure',
  '.kube',
  '.docker/config.json',
];

const BLOCKED_FILES = [
  '.wmux-auth-token',
  '.npmrc',
  '.netrc',
  '.env',
  '.wmux/daemon-auth-token',
];

export function isSensitivePath(resolvedPath: string): boolean {
  const home = os.homedir();
  const normalized = resolvedPath.replace(/\\/g, '/').toLowerCase();
  const homeNorm = home.replace(/\\/g, '/').toLowerCase();

  // Block directories under home
  for (const dir of BLOCKED_DIRS) {
    const blocked = (homeNorm + '/' + dir).toLowerCase();
    if (normalized.startsWith(blocked)) return true;
  }

  // Block specific files in home
  for (const file of BLOCKED_FILES) {
    const blocked = (homeNorm + '/' + file).toLowerCase();
    if (normalized === blocked) return true;
  }

  // Block Windows credential stores
  if (process.platform === 'win32') {
    if (normalized.includes('/appdata/roaming/microsoft/credentials')) return true;
    if (normalized.includes('/appdata/local/microsoft/credentials')) return true;
  }

  return false;
}

export async function resolveAccessiblePath(inputPath: string): Promise<string | null> {
  if (!inputPath || typeof inputPath !== 'string') return null;

  const resolved = path.resolve(inputPath);
  if (isSensitivePath(resolved)) return null;

  try {
    const canonical = await fs.promises.realpath(resolved);
    if (isSensitivePath(canonical)) return null;
    return canonical;
  } catch {
    return null;
  }
}

export function closeAllWatchers(): void {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export function registerFsHandlers(): () => void {
  ipcMain.removeHandler(IPC.FS_READ_DIR);
  ipcMain.handle(IPC.FS_READ_DIR, async (_event, dirPath: string): Promise<FileEntry[]> => {
    const resolved = await resolveAccessiblePath(dirPath);
    if (!resolved) return [];

    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const result: FileEntry[] = [];

      for (const entry of entries) {
        // node_modules, .git 기본 제외 (너무 큼)
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        result.push({
          name: entry.name,
          path: path.join(resolved, entry.name),
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink(),
        });
      }

      // 디렉토리 먼저, 그 다음 파일. 각각 알파벳 순
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      return result;
    } catch {
      return [];
    }
  });

  ipcMain.removeHandler(IPC.FS_READ_FILE);
  ipcMain.handle(IPC.FS_READ_FILE, async (_event, filePath: string): Promise<string | null> => {
    const resolved = await resolveAccessiblePath(filePath);
    if (!resolved) return null;
    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.size > 1024 * 1024) return null; // 1MB limit
      return await fs.promises.readFile(resolved, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.removeHandler(IPC.FS_WATCH);
  ipcMain.handle(IPC.FS_WATCH, async (_event, dirPath: string) => {
    const resolved = await resolveAccessiblePath(dirPath);
    if (!resolved) return false;

    // Clean up previous watcher for this path
    if (watchers.has(resolved)) {
      watchers.get(resolved)!.close();
      watchers.delete(resolved);
    }

    if (watchers.size >= MAX_WATCHERS) {
      return false;
    }

    try {
      const watcher = fs.watch(resolved, { persistent: false }, () => {
        // Debounce: ignore duplicate events within 500ms
        if (debounceTimers.has(resolved)) {
          clearTimeout(debounceTimers.get(resolved)!);
        }
        debounceTimers.set(resolved, setTimeout(() => {
          debounceTimers.delete(resolved);
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC.FS_CHANGED, resolved);
          }
        }, 500));
      });

      watcher.on('error', () => {
        // Silently close on error
        watcher.close();
        watchers.delete(resolved);
      });

      watchers.set(resolved, watcher);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(IPC.FS_UNWATCH);
  ipcMain.handle(IPC.FS_UNWATCH, async (_event, dirPath: string) => {
    const resolved = await resolveAccessiblePath(dirPath);
    if (!resolved) return;
    const watcher = watchers.get(resolved);
    if (watcher) {
      watcher.close();
      watchers.delete(resolved);
    }
    const timer = debounceTimers.get(resolved);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(resolved);
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.FS_READ_DIR);
    ipcMain.removeHandler(IPC.FS_READ_FILE);
    ipcMain.removeHandler(IPC.FS_WATCH);
    ipcMain.removeHandler(IPC.FS_UNWATCH);
    closeAllWatchers();
  };
}
