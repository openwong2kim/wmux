import { ipcMain, shell, app } from 'electron';
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

  // Open an absolute filesystem path. Invoked by Ctrl+click on path tokens
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

  return () => {
    ipcMain.removeHandler(IPC.SHELL_LIST);
    ipcMain.removeHandler(IPC.SHELL_OPEN_EXTERNAL);
    ipcMain.removeHandler(IPC.SHELL_OPEN_PATH);
    ipcMain.removeHandler(IPC.APP_MEMORY);
    ipcMain.removeHandler(IPC.AUTOSTART_GET);
    ipcMain.removeHandler(IPC.AUTOSTART_SET);
  };
}
