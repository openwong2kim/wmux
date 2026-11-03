import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../../../shared/constants';
import { isUncOrDevicePath } from '../../../shared/cwdShape';
import { wrapHandler } from '../wrapHandler';
import { focusedPrimaryWindow, primaryWindow } from '../../window/auxiliaryWindows';

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

/**
 * The home folder as given and as its real path. A canonical (realpath'd)
 * path must be compared with the real home: when home is reached through a
 * symlink, or on Windows through an 8.3 short name, the two spellings differ
 * and a symlink into ~/.ssh would otherwise pass the check on its target.
 */
export function homeRoots(): string[] {
  const home = os.homedir();
  let real = home;
  try {
    real = fs.realpathSync.native(home);
  } catch {
    // An unreadable home keeps the given spelling only.
  }
  const roots = [home, real].map((h) => h.replace(/\\/g, '/').toLowerCase());
  return roots[0] === roots[1] ? [roots[0]] : roots;
}

export function isSensitivePath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replace(/\\/g, '/').toLowerCase();

  for (const homeNorm of homeRoots()) {
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
  }

  // Block Windows credential stores
  if (process.platform === 'win32') {
    if (normalized.includes('/appdata/roaming/microsoft/credentials')) return true;
    if (normalized.includes('/appdata/local/microsoft/credentials')) return true;
  }

  return false;
}

/**
 * A network or device path, as given or once resolved: POSIX path.resolve
 * folds a leading `//`, and a relative input takes the process cwd's root.
 * Pure, so a caller can refuse the path before any filesystem call.
 */
export function isNonLocalPath(inputPath: string): boolean {
  return isUncOrDevicePath(inputPath) || isUncOrDevicePath(path.resolve(inputPath));
}

export async function resolveAccessiblePath(inputPath: string): Promise<string | null> {
  if (!inputPath || typeof inputPath !== 'string') return null;

  // Local folders only, refused before realpath or any other filesystem call.
  if (isNonLocalPath(inputPath)) return null;
  const resolved = path.resolve(inputPath);
  if (isSensitivePath(resolved)) return null;

  try {
    const canonical = await fs.promises.realpath(resolved);
    if (isSensitivePath(canonical)) return null;
    if (!isUncOrDevicePath(canonical)) {
      // A drive that leads to no share (any more) has no entry.
      if (DRIVE_PATH.test(inputPath)) mappedDrives.delete(driveKey(inputPath));
      return canonical;
    }
    // A drive path whose real path is below the share its drive leads to: a
    // mapped network drive the user set up. Any other input that lands on a
    // share or a device (a link or junction to one) is refused.
    if (!DRIVE_PATH.test(inputPath) || DEVICE_PATH.test(canonical)) return null;
    return await spelledFromDrive(inputPath, canonical);
  } catch {
    return null;
  }
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const DEVICE_PATH = /^[\\/]{2}[?.][\\/]/;

/**
 * Each mapped network drive an accepted drive path was on: its root (`Z:\\`)
 * and the share it leads to (`\\\\server\\share`). Read again on every drive
 * path, so a drive mapped elsewhere since, or no longer mapped, updates it.
 */
const mappedDrives = new Map<string, string>();
const driveKey = (drivePath: string) => path.win32.parse(path.win32.resolve(drivePath)).root.toUpperCase();

/** `p` below `share`, spelled from `root`; null when it is not below it. */
function underShare(p: string, share: string, root: string): string | null {
  const unc = p.replace(/\//g, '\\');
  const rest = unc.slice(share.length);
  if (!unc.toLowerCase().startsWith(share.toLowerCase()) || !/^(?:\\|$)/.test(rest)) return null;
  return path.win32.join(root, rest);
}

/**
 * A mapped drive's real path (`\\server\share\repo`) spelled from its drive
 * again (`Z:\repo`), so the answer, and a folder below it, passes this check
 * when a caller hands it back. Null when the real path is not below the share
 * the drive root leads to: a link on a local drive, or one on the mapped
 * drive to another share, or a root that cannot be read.
 */
async function spelledFromDrive(inputPath: string, canonical: string): Promise<string | null> {
  const drivePath = path.win32.resolve(inputPath);
  const root = path.win32.parse(drivePath).root;
  const key = driveKey(drivePath);
  mappedDrives.delete(key);
  try {
    const share = (await fs.promises.realpath(root)).replace(/[\\/]+$/, '').replace(/\//g, '\\');
    const onShare = isUncOrDevicePath(share) && !DEVICE_PATH.test(share);
    if (!onShare) return null;
    mappedDrives.set(key, share);
    return underShare(canonical, share, root);
  } catch {
    return null;
  }
}

/**
 * A path git reported (`--show-toplevel`, `worktree list`) for `accepted`, an
 * answer of resolveAccessiblePath, in the spelling that check accepts: git
 * answers a mapped drive's folders as its share (`//server/share/repo`), so
 * they are spelled from the drive `accepted` is on (`Z:\\repo`), as that
 * check last found it mapped. Null for a share or device path below no such
 * drive; a local path is returned as it is.
 */
export function localSpelling(p: string, accepted: string): string | null {
  if (!isUncOrDevicePath(p)) return p;
  if (!DRIVE_PATH.test(accepted)) return null;
  const share = mappedDrives.get(driveKey(accepted));
  return share ? underShare(p, share, path.win32.parse(path.win32.resolve(accepted)).root) : null;
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
  ipcMain.handle(IPC.FS_READ_DIR, wrapHandler(IPC.FS_READ_DIR, async (_event: Electron.IpcMainInvokeEvent, dirPath: string): Promise<FileEntry[]> => {
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
  }));

  ipcMain.removeHandler(IPC.FS_READ_FILE);
  ipcMain.handle(IPC.FS_READ_FILE, wrapHandler(IPC.FS_READ_FILE, async (_event: Electron.IpcMainInvokeEvent, filePath: string): Promise<string | null> => {
    const resolved = await resolveAccessiblePath(filePath);
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
  ipcMain.handle(IPC.FS_WRITE_FILE, wrapHandler(IPC.FS_WRITE_FILE, async (_event: Electron.IpcMainInvokeEvent, filePath: string, content: string): Promise<boolean> => {
    if (typeof filePath !== 'string' || typeof content !== 'string') return false;
    const resolved = path.resolve(filePath);
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
  ipcMain.handle(IPC.FS_WATCH, wrapHandler(IPC.FS_WATCH, async (_event: Electron.IpcMainInvokeEvent, dirPath: string) => {
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
          const win = focusedPrimaryWindow() ?? primaryWindow();
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
  }));

  ipcMain.removeHandler(IPC.FS_UNWATCH);
  ipcMain.handle(IPC.FS_UNWATCH, wrapHandler(IPC.FS_UNWATCH, async (_event: Electron.IpcMainInvokeEvent, dirPath: string) => {
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
