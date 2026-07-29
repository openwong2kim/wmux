import { ipcMain, shell, app } from 'electron';
import { spawn, execFile } from 'child_process';
import * as path from 'path';
import { ShellDetector } from '../../../shared/ShellDetector';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { isAutostartEnabled, setAutostartEnabled } from '../../autostart';

// Hard cap on the path string the renderer can send. Long enough for
// Windows long-path (\\?\ prefix + ~32k) callers but small enough that a
// runaway buffer dump cannot lock the main process inside path.normalize.
const MAX_PATH_LENGTH = 4096;

// File extensions that launch executable code through OS shell association.
// `shell.openPath` on a path with one of these extensions is equivalent to
// the user double-clicking it in Explorer — arbitrary code execution.
// Renderer-supplied paths originate from PTY output, which is untrusted
// (a malicious git log message or pasted curl output could place such a
// path on screen for the user to mis-click). We refuse to default-open
// them and reveal the parent folder instead, so the user can still locate
// the file and open it deliberately with a tool of their choice.
//
// Lowercase for case-insensitive lookup via `extname(...).toLowerCase()`.
const BLOCKED_EXTENSIONS = new Set<string>([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi',
  '.reg', '.lnk', '.hta', '.cpl',
]);

export function registerShellHandlers(): () => void {
  const detector = new ShellDetector();

  ipcMain.removeHandler(IPC.SHELL_LIST);
  ipcMain.handle(IPC.SHELL_LIST, wrapHandler(IPC.SHELL_LIST, (_event: Electron.IpcMainInvokeEvent) => {
    return detector.detect();
  }));

  ipcMain.removeHandler(IPC.SHELL_OPEN_EXTERNAL);
  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, wrapHandler(IPC.SHELL_OPEN_EXTERNAL, (_event: Electron.IpcMainInvokeEvent, url: string) => {
    if (typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
      throw new Error('Only http/https URLs are allowed');
    }
    return shell.openExternal(url);
  }));

  // Open an absolute filesystem path. Invoked by Ctrl+click (mac: Cmd+click) on path tokens
  // surfaced via the terminal link provider. Validation is intentionally
  // strict — the renderer can match arbitrary text, so main treats every
  // payload as untrusted:
  //   • must be a string of length ≥ 1 and ≤ MAX_PATH_LENGTH
  //   • no NUL bytes (defense against C-string truncation tricks)
  //   • must be an absolute path on the current OS (path.isAbsolute)
  //
  // Behaviour: shell.openPath opens folders in Explorer / Finder and files
  // with the OS default app. When that fails (missing file, no associated
  // app, permission denied) we fall back to showItemInFolder so the user
  // can still locate the target.
  ipcMain.removeHandler(IPC.SHELL_OPEN_PATH);
  ipcMain.handle(IPC.SHELL_OPEN_PATH, wrapHandler(IPC.SHELL_OPEN_PATH, async (_event: Electron.IpcMainInvokeEvent, rawPath: string) => {
    if (typeof rawPath !== 'string') {
      throw new Error('path must be a string');
    }
    if (rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH) {
      throw new Error('path length out of range');
    }
    if (rawPath.includes('\0')) {
      throw new Error('path must not contain NUL bytes');
    }
    // Normalize first so '..' segments collapse to a real on-disk path
    // before the absolute-path check; otherwise a payload like
    // 'C:\\foo\\..\\..\\..\\Windows\\System32\\calc.exe' would pass the
    // raw isAbsolute test while still escaping the user-clicked location.
    const normalized = path.normalize(rawPath);
    if (!path.isAbsolute(normalized)) {
      throw new Error('path must be absolute');
    }
    // Block executable extensions — refuse the open and reveal the folder
    // so the user still gets useful feedback without launching code from
    // untrusted PTY content. See BLOCKED_EXTENSIONS for the rationale.
    const ext = path.extname(normalized).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      shell.showItemInFolder(normalized);
      return { ok: false, error: 'BLOCKED_EXTENSION' };
    }
    const err = await shell.openPath(normalized);
    if (err) {
      // openPath returns an error string when the file is missing, has no
      // associated handler, or the OS refused the open. Reveal the parent
      // folder so the user still gets useful feedback instead of a silent
      // no-op.
      shell.showItemInFolder(normalized);
    }
    return { ok: !err, error: err || undefined };
  }));

  // Total app memory across the whole Electron process tree. The StatusBar
  // RAM widget used to read performance.memory.usedJSHeapSize in the renderer,
  // which is just this renderer's V8 JS heap (~10MB) — it excludes the
  // renderer's native/RSS footprint, the main process, the GPU process, every
  // other renderer, and Utility processes, so the displayed figure was off by
  // an order of magnitude. app.getAppMetrics() reports per-process
  // workingSetSize (RSS) in KB; summing it gives the real footprint. (The
  // detached wmux daemon is a separate process not covered by getAppMetrics.)
  ipcMain.removeHandler(IPC.APP_MEMORY);
  ipcMain.handle(IPC.APP_MEMORY, wrapHandler(IPC.APP_MEMORY, (_event: Electron.IpcMainInvokeEvent) => {
    let totalKB = 0;
    for (const m of app.getAppMetrics()) {
      totalKB += m.memory?.workingSetSize ?? 0;
    }
    return totalKB * 1024; // bytes
  }));

  // Windows "start on login" toggle (issue #460). The per-user Run registry
  // key is the source of truth; GET reads it, SET writes it and echoes back
  // the resulting state so an optimistic renderer can reconcile. Both are
  // no-ops returning { enabled: false } on non-Windows platforms.
  //
  // Gated on app.isPackaged: under `electron-forge start`, process.execPath is
  // the dev electron.exe but the Run value name (`wmux`) is SHARED with the
  // installed app. Writing it would overwrite the installed app's entry with
  // an unlaunchable bare-electron command, and disabling would delete the real
  // one. So in dev the toggle is inert (reports off, writes nothing) — only
  // the packaged app, whose execPath is the true install target, may touch it.
  ipcMain.removeHandler(IPC.AUTOSTART_GET);
  ipcMain.handle(IPC.AUTOSTART_GET, wrapHandler(IPC.AUTOSTART_GET, (_event: Electron.IpcMainInvokeEvent) => {
    if (!app.isPackaged) return { enabled: false };
    return { enabled: isAutostartEnabled() };
  }));

  ipcMain.removeHandler(IPC.AUTOSTART_SET);
  ipcMain.handle(IPC.AUTOSTART_SET, wrapHandler(IPC.AUTOSTART_SET, (_event: Electron.IpcMainInvokeEvent, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    if (!app.isPackaged) return { enabled: false };
    return { enabled: setAutostartEnabled(enabled) };
  }));

  // SHELL_DETECT_APPS — detect folder-opening apps available on the system.
  // Called on demand from the workspace context menu; not cached.
  ipcMain.removeHandler(IPC.SHELL_DETECT_APPS);
  ipcMain.handle(IPC.SHELL_DETECT_APPS, wrapHandler(IPC.SHELL_DETECT_APPS, () => {
    return getAvailableFolderApps();
  }));

  // SHELL_OPEN_WITH — open a folder with a specific detected app.
  ipcMain.removeHandler(IPC.SHELL_OPEN_WITH);
  ipcMain.handle(IPC.SHELL_OPEN_WITH, wrapHandler(IPC.SHELL_OPEN_WITH, async (_event, payload: { appId: string; folderPath: string }) => {
    const { appId, folderPath } = payload ?? {};
    if (!appId || typeof folderPath !== 'string') {
      throw new Error('payload must contain appId and folderPath');
    }
    const normalized = path.normalize(folderPath);
    if (!path.isAbsolute(normalized)) {
      throw new Error('folderPath must be absolute');
    }

    if (appId === 'explorer') {
      const err = await shell.openPath(normalized);
      if (err) shell.showItemInFolder(normalized);
      return { ok: !err, error: err || undefined };
    }

    const appEntry = (await getAvailableFolderApps()).find(a => a.id === appId);
    if (!appEntry) throw new Error(`Unknown app: ${appId}`);

    try {
      const proc = spawn(appEntry.command, [...appEntry.args, normalized], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.on('error', (err) => {
        // Log but can't reject — we've already unref'd and resolved
        console.error(`[shell] failed to open with ${appId}:`, err.message);
      });
      proc.unref();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }));

  return () => {
    ipcMain.removeHandler(IPC.SHELL_LIST);
    ipcMain.removeHandler(IPC.SHELL_OPEN_EXTERNAL);
    ipcMain.removeHandler(IPC.SHELL_OPEN_PATH);
    ipcMain.removeHandler(IPC.APP_MEMORY);
    ipcMain.removeHandler(IPC.AUTOSTART_GET);
    ipcMain.removeHandler(IPC.AUTOSTART_SET);
    ipcMain.removeHandler(IPC.SHELL_DETECT_APPS);
    ipcMain.removeHandler(IPC.SHELL_OPEN_WITH);
  };
}

interface FolderAppEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
}

// Per-probe cap on where.exe. A wedged probe (AV interception, a stale network
// PATH entry that where.exe walks) must not keep the submenu spinning.
const WHERE_TIMEOUT_MS = 1000;

// Absolute path to where.exe rather than bare 'where', matching the rest of the
// main process (see autostart.ts regExe): a PATH-resolved name is attacker
// influenceable, an absolute System32 path is not.
function whereExe(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'where.exe');
}

// Candidate launchers, probed in menu order. Kept as data so the probe below
// can fan out over all of them at once instead of one blocking call per app.
const WIN_FOLDER_APP_CANDIDATES: readonly FolderAppEntry[] = [
  { id: 'code', name: 'VS Code', command: 'code.cmd', args: [] },
  { id: 'code-insiders', name: 'VS Code - Insiders', command: 'code-insiders.cmd', args: [] },
  { id: 'cursor', name: 'Cursor', command: 'cursor', args: [] },
  { id: 'windsurf', name: 'Windsurf', command: 'windsurf', args: [] },
  { id: 'wt', name: 'Windows Terminal', command: 'wt', args: ['-d'] },
];

// Async on purpose. execFileSync blocks the main process event loop for the
// whole spawn, and this runs once per context-menu open with one probe per
// candidate app — under AV interception that is seconds of frozen UI (no PTY
// data pumped, no IPC served). execFile + Promise.all costs one event-loop
// turn and the probes overlap, so the total is the slowest probe, not the sum.
function hasCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(whereExe(), [cmd], { timeout: WHERE_TIMEOUT_MS, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

async function getAvailableFolderApps(): Promise<FolderAppEntry[]> {
  // Explorer is always present — shell.openPath handles it, no probe needed.
  const apps: FolderAppEntry[] = [
    { id: 'explorer', name: 'File Explorer', command: '', args: [] },
  ];

  // Non-Windows: shell.openPath already covers Finder / xdg-open, and no
  // extra launcher is wired up yet, so there is nothing to probe for.
  if (process.platform !== 'win32') {
    return apps;
  }

  const found = await Promise.all(
    WIN_FOLDER_APP_CANDIDATES.map(app => hasCommand(app.command)),
  );
  WIN_FOLDER_APP_CANDIDATES.forEach((app, i) => {
    if (found[i]) apps.push({ ...app });
  });

  return apps;
}
