import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../../../shared/constants';
import {
  hostLocation,
  parseSessionLocation,
  toHostAccessiblePath,
  toWslGuestPath,
  type SessionLocation,
} from '../../../shared/sessionLocation';
import { wrapHandler } from '../wrapHandler';

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
  '.fmux-auth-token',
  '.npmrc',
  '.netrc',
  '.env',
  '.fmux/daemon-auth-token',
];

function isBlockedHomeRelative(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, '').toLowerCase();
  for (const dir of BLOCKED_DIRS) {
    const blocked = dir.toLowerCase();
    if (normalized === blocked || normalized.startsWith(`${blocked}/`)) return true;
  }
  return BLOCKED_FILES.some((file) => normalized === file.toLowerCase());
}

function homeRelativePath(
  candidatePath: string,
  location?: SessionLocation,
): string | null {
  const normalized = candidatePath.replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  if (normalized.toLowerCase().startsWith(`${home.toLowerCase()}/`)) {
    return normalized.slice(home.length + 1);
  }

  const guestPath = toWslGuestPath(location, candidatePath);
  if (!guestPath) return null;
  const userHome = /^\/home\/[^/]+(?:\/(.*))?$/i.exec(guestPath);
  if (userHome) return userHome[1] ?? '';
  const rootHome = /^\/root(?:\/(.*))?$/i.exec(guestPath);
  return rootHome ? rootHome[1] ?? '' : null;
}

export function isSensitivePath(
  resolvedPath: string,
  location?: SessionLocation,
): boolean {
  const normalized = resolvedPath.replace(/\\/g, '/').toLowerCase();

  // Block Windows credential stores
  if (process.platform === 'win32') {
    if (normalized.includes('/appdata/roaming/microsoft/credentials')) return true;
    if (normalized.includes('/appdata/local/microsoft/credentials')) return true;
  }

  const homeRelative = homeRelativePath(resolvedPath, location);
  return homeRelative !== null && isBlockedHomeRelative(homeRelative);
}

interface FileLocationRequest {
  path: string;
  location: SessionLocation;
}

type LocationPathOperation = typeof toHostAccessiblePath;

/**
 * Read the `{ path, location }` wire payload. The location contract itself is
 * validated by `parseSessionLocation` — the ONE wire validator (issue #21) —
 * so `msys` is accepted here like any other domain, and whether a host
 * location's path is actually reachable is decided by `toHostAccessiblePath`
 * rather than by a `process.platform === 'win32' && isLinuxLikeCwd(...)` sniff
 * in this file.
 */
function readFileLocationRequest(raw: unknown): FileLocationRequest | null {
  if (typeof raw === 'string') {
    const location = parseSessionLocation(raw);
    return location ? { path: location.cwd, location } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const req = raw as { path?: unknown; location?: unknown };
  if (typeof req.path !== 'string' || !req.path) return null;
  const location = parseSessionLocation(req.location);
  return location ? { path: req.path, location } : null;
}

export async function resolveAccessiblePath(
  inputPath: string,
  location: SessionLocation = hostLocation(inputPath),
  convert: LocationPathOperation = toHostAccessiblePath,
): Promise<string | null> {
  if (!inputPath || typeof inputPath !== 'string') return null;
  if (isSensitivePath(inputPath, location)) return null;

  const accessible = convert(location, inputPath);
  if (!accessible.ok) return null;
  const resolved = path.resolve(accessible.path);
  if (isSensitivePath(resolved, location)) return null;

  try {
    const canonical = await fs.promises.realpath(resolved);
    if (isSensitivePath(canonical, location)) return null;
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
  ipcMain.handle(IPC.FS_READ_DIR, wrapHandler(IPC.FS_READ_DIR, async (_event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<FileEntry[]> => {
    const req = readFileLocationRequest(raw);
    if (!req) return [];
    const resolved = await resolveAccessiblePath(req.path, req.location);
    if (!resolved) return [];

    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const result: FileEntry[] = [];

      for (const entry of entries) {
        // Exclude node_modules and .git by default (too large)
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        result.push({
          name: entry.name,
          path: path.join(resolved, entry.name),
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink(),
        });
      }

      // Directories first, then files — each group alphabetically
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      return result;
    } catch {
      return [];
    }
  }));

  ipcMain.removeHandler(IPC.FS_READ_FILE);
  ipcMain.handle(IPC.FS_READ_FILE, wrapHandler(IPC.FS_READ_FILE, async (_event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<string | null> => {
    const req = readFileLocationRequest(raw);
    if (!req) return null;
    const resolved = await resolveAccessiblePath(req.path, req.location);
    if (!resolved) return null;
    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.size > 1024 * 1024) return null; // 1MB limit
      return await fs.promises.readFile(resolved, 'utf-8');
    } catch {
      return null;
    }
  }));

  ipcMain.removeHandler(IPC.FS_WRITE_FILE);
  ipcMain.handle(IPC.FS_WRITE_FILE, wrapHandler(IPC.FS_WRITE_FILE, async (_event: Electron.IpcMainInvokeEvent, raw: unknown, content: string): Promise<boolean> => {
    const req = readFileLocationRequest(raw);
    if (!req) return false;
    const filePath = req.path;
    if (typeof filePath !== 'string' || typeof content !== 'string') return false;
    const accessible = toHostAccessiblePath(req.location, filePath);
    if (!accessible.ok) return false;
    const resolved = path.resolve(accessible.path);
    if (isSensitivePath(resolved)) return false;
    // Only allow writing CLAUDE.md files (for persona injection)
    if (path.basename(resolved) !== 'CLAUDE.md') return false;
    // Size limit: 100KB
    if (content.length > 100 * 1024) return false;
    try {
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, content, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }));

  ipcMain.removeHandler(IPC.FS_WATCH);
  ipcMain.handle(IPC.FS_WATCH, wrapHandler(IPC.FS_WATCH, async (_event: Electron.IpcMainInvokeEvent, raw: unknown) => {
    const req = readFileLocationRequest(raw);
    if (!req) return false;
    const resolved = await resolveAccessiblePath(req.path, req.location);
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
            // Preserve the canonical host path expected by existing callers.
            // WSL callers keep their guest-path identity so renderer state can
            // match the event to the tree it requested.
            win.webContents.send(
              IPC.FS_CHANGED,
              req.location.domain === 'wsl' ? req.path : resolved,
            );
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
  }));

  ipcMain.removeHandler(IPC.FS_UNWATCH);
  ipcMain.handle(IPC.FS_UNWATCH, wrapHandler(IPC.FS_UNWATCH, async (_event: Electron.IpcMainInvokeEvent, raw: unknown) => {
    const req = readFileLocationRequest(raw);
    if (!req) return;
    const resolved = await resolveAccessiblePath(req.path, req.location);
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
  }));

  return () => {
    ipcMain.removeHandler(IPC.FS_READ_DIR);
    ipcMain.removeHandler(IPC.FS_READ_FILE);
    ipcMain.removeHandler(IPC.FS_WRITE_FILE);
    ipcMain.removeHandler(IPC.FS_WATCH);
    ipcMain.removeHandler(IPC.FS_UNWATCH);
    closeAllWatchers();
  };
}
