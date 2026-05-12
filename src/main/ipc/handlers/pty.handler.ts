import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PTYManager } from '../../pty/PTYManager';
import { PTYBridge } from '../../pty/PTYBridge';
import { DaemonClient } from '../../DaemonClient';
import { IPC, getPidMapDir } from '../../../shared/constants';
import { sanitizePtyText } from '../../../shared/types';
import { updateCwd } from './metadata.handler';
import { markResize, markUserWrite } from '../../notification/idleSuppression';
import { wrapHandler } from '../wrapHandler';

/**
 * Allowed shell basenames (compared case-insensitively).
 * Only these executables may be spawned via IPC.
 * Windows entries keep `.exe`; Unix entries (mac/linux) are bare basenames
 * so that detector paths like `/bin/zsh` or `/opt/homebrew/bin/pwsh` resolve.
 */
const ALLOWED_SHELLS = new Set([
  // Windows
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'bash.exe',
  'wsl.exe',
  'git-bash.exe',
  'sh.exe',
  // Unix (mac/linux)
  'zsh',
  'bash',
  'fish',
  'pwsh',
  'sh',
]);

function isAllowedShell(shell: string): boolean {
  const basename = path.basename(shell).toLowerCase();
  return ALLOWED_SHELLS.has(basename);
}

/**
 * Validate and resolve cwd. Returns undefined if invalid.
 * Shared by both daemon and local modes.
 */
function validateCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  // Block UNC paths (e.g. \\server\share)
  if (resolved.startsWith('\\\\')) return undefined;
  if (!fs.existsSync(resolved)) return undefined;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return undefined;
  return resolved;
}

/** Write sessionId/PID → workspaceId mapping for MCP identity resolution */
function writePidMap(key: string | number, workspaceId: string): void {
  try {
    const dir = getPidMapDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(key)), workspaceId, 'utf8');
  } catch { /* best-effort */ }
}

export function registerPTYHandlers(
  ptyManager: PTYManager,
  ptyBridge: PTYBridge,
  daemonClient?: DaemonClient,
  getWindow?: () => BrowserWindow | null,
): () => void {
  const useDaemon = daemonClient?.isConnected ?? false;

  // Track daemon session:data listeners by sessionId so PTY_CREATE / PTY_RECONNECT
  // can be idempotent. Without per-id tracking, every reconcile (mount + each
  // daemon.onConnected) would push another listener for an already-active
  // session, and the same PTY frame would be forwarded to the renderer N times
  // — manifesting as spinner lines stacking up and characters smearing across
  // rows in TUIs like Claude Code.
  const daemonSessionListeners = new Map<string, (...args: unknown[]) => void>();

  /** Register (or replace) the per-session data listener for `sessionId`. */
  function setSessionDataListener(
    sessionId: string,
    listener: (...args: unknown[]) => void,
  ): void {
    if (!daemonClient) return;
    const existing = daemonSessionListeners.get(sessionId);
    if (existing) {
      daemonClient.removeListener('session:data', existing);
    }
    daemonClient.on('session:data', listener);
    daemonSessionListeners.set(sessionId, listener);
  }

  /** Remove the per-session data listener for `sessionId`, if any. */
  function clearSessionDataListener(sessionId: string): void {
    if (!daemonClient) return;
    const existing = daemonSessionListeners.get(sessionId);
    if (!existing) return;
    daemonClient.removeListener('session:data', existing);
    daemonSessionListeners.delete(sessionId);
  }

  // Per-session StringDecoder to handle UTF-8 multi-byte sequences split across chunks
  const sessionDecoders = new Map<string, StringDecoder>();
  function decodeSessionData(sessionId: string, data: Buffer): string {
    let decoder = sessionDecoders.get(sessionId);
    if (!decoder) {
      decoder = new StringDecoder('utf8');
      sessionDecoders.set(sessionId, decoder);
    }
    return decoder.write(data);
  }

  // pty:create
  ipcMain.removeHandler(IPC.PTY_CREATE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_CREATE, wrapHandler(IPC.PTY_CREATE, async (_event: Electron.IpcMainInvokeEvent, options?: { shell?: string; cwd?: string; cols?: number; rows?: number; workspaceId?: string }) => {
      if (options?.shell !== undefined && !isAllowedShell(options.shell)) {
        throw new Error(`PTY_CREATE: shell not allowed: ${options.shell}`);
      }

      const safeCwd = validateCwd(options?.cwd);
      const effectiveCwd = safeCwd ?? require('os').homedir();
      const shell = options?.shell || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));

      // Generate a unique session ID
      const crypto = require('crypto');
      const sessionId = `daemon-${crypto.randomUUID().slice(0, 8)}`;

      // Create session via daemon RPC
      const result = await daemonClient.rpc('daemon.createSession', {
        id: sessionId,
        cmd: shell,
        cwd: effectiveCwd,
        cols: options?.cols || 80,
        rows: options?.rows || 24,
      });

      // Attach to the session (makes daemon start the SessionPipe server)
      await daemonClient.rpc('daemon.attachSession', { id: sessionId });

      // Connect session data pipe
      await daemonClient.connectSessionPipe(sessionId);

      // Forward session data to renderer. Routed through the per-id helper so
      // a stale listener (from a prior create with the same id, or a reconnect)
      // is removed before the new one is attached.
      const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
        if (payload.sessionId !== sessionId) return;
        const win = getWindow?.();
        if (win && !win.isDestroyed()) {
          const text = decodeSessionData(sessionId, payload.data);
          if (text) win.webContents.send(IPC.PTY_DATA, sessionId, text);
        }
      };
      setSessionDataListener(sessionId, onSessionData as (...args: unknown[]) => void);

      // Register initial CWD
      updateCwd(sessionId, effectiveCwd);

      // Write shell PID→workspaceId mapping for MCP workspace identity resolution
      // (Claude Code doesn't propagate env vars to MCP child processes)
      const shellPid = (result as { pid?: number })?.pid;
      if (options?.workspaceId && shellPid) {
        writePidMap(shellPid, options.workspaceId);
      }

      return { id: sessionId, shell, cwd: effectiveCwd };
    }));
  } else {
    ipcMain.handle(IPC.PTY_CREATE, wrapHandler(IPC.PTY_CREATE, (_event: Electron.IpcMainInvokeEvent, options?: { shell?: string; cwd?: string; cols?: number; rows?: number; workspaceId?: string; surfaceId?: string }) => {
      if (options?.shell !== undefined && !isAllowedShell(options.shell)) {
        throw new Error(`PTY_CREATE: shell not allowed: ${options.shell}`);
      }

      const safeCwd = validateCwd(options?.cwd);
      const effectiveCwd = safeCwd ?? undefined;
      const instance = ptyManager.create(effectiveCwd !== undefined ? { ...options, cwd: effectiveCwd } : { ...options, cwd: undefined });
      ptyBridge.setupDataForwarding(instance.id);
      const actualCwd = effectiveCwd || require('os').homedir();
      updateCwd(instance.id, actualCwd);
      return { id: instance.id, shell: instance.shell, cwd: actualCwd };
    }));
  }

  // pty:write
  // User keystrokes echo back through the PTY (the shell/TUI writes them
  // to the screen), so they show up to ActivityMonitor as agent output.
  // Mark the user-write timestamp so the idle fallback suppresses itself
  // while the user is typing (see idleSuppression.ts).
  ipcMain.removeAllListeners(IPC.PTY_WRITE);
  if (useDaemon && daemonClient) {
    const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
      if (typeof data !== 'string') return;
      if (data.length > 100_000) {
        console.warn(`[PTY_WRITE] dropped oversize write: ${data.length} chars (limit 100_000). This is a backstop; renderer should chunk.`);
        return; // prevent mega-writes
      }
      markUserWrite(id);
      daemonClient.writeToSession(id, sanitizePtyText(data));
    };
    ipcMain.on(IPC.PTY_WRITE, onPtyWrite);
  } else {
    const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
      if (!ptyManager.get(id)) return;
      if (typeof data !== 'string') return;
      if (data.length > 100_000) {
        console.warn(`[PTY_WRITE] dropped oversize write: ${data.length} chars (limit 100_000). This is a backstop; renderer should chunk.`);
        return;
      }
      markUserWrite(id);
      ptyManager.write(id, sanitizePtyText(data));
    };
    ipcMain.on(IPC.PTY_WRITE, onPtyWrite);
  }

  // pty:resize
  // TUI agents (Claude, Codex, etc.) respond to SIGWINCH with a full-screen
  // redraw, which spikes ActivityMonitor's byte counter and triggers the
  // "Task may have finished" fallback when the user moves on within 5s.
  // Mark the resize timestamp so the fallback suppresses itself for the
  // suppression window (see idleSuppression.ts).
  ipcMain.removeHandler(IPC.PTY_RESIZE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_RESIZE, wrapHandler(IPC.PTY_RESIZE, async (_event: Electron.IpcMainInvokeEvent, id: string, cols: number, rows: number) => {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
      }
      markResize(id);
      try {
        await daemonClient.rpc('daemon.resizeSession', { id, cols, rows });
      } catch (err: unknown) {
        // Session may have been destroyed during reconciliation — ignore gracefully
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found') || msg.includes('not exist')) return;
        throw err;
      }
    }));
  } else {
    ipcMain.handle(IPC.PTY_RESIZE, wrapHandler(IPC.PTY_RESIZE, (_event: Electron.IpcMainInvokeEvent, id: string, cols: number, rows: number) => {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
      }
      if (!ptyManager.get(id)) return;
      markResize(id);
      ptyManager.resize(id, cols, rows);
    }));
  }

  // pty:dispose
  ipcMain.removeHandler(IPC.PTY_DISPOSE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_DISPOSE, wrapHandler(IPC.PTY_DISPOSE, async (_event: Electron.IpcMainInvokeEvent, id: string) => {
      await daemonClient.rpc('daemon.destroySession', { id });
      await daemonClient.disconnectSessionPipe(id);
      sessionDecoders.delete(id);
      // Drop the data forwarding listener for this session so a future
      // create or reconnect doesn't pile new listeners on top of dead ones.
      clearSessionDataListener(id);
    }));
  } else {
    ipcMain.handle(IPC.PTY_DISPOSE, wrapHandler(IPC.PTY_DISPOSE, (_event: Electron.IpcMainInvokeEvent, id: string) => {
      ptyManager.dispose(id);
    }));
  }

  // pty:list
  ipcMain.removeHandler(IPC.PTY_LIST);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_LIST, wrapHandler(IPC.PTY_LIST, async () => {
      const sessions = await daemonClient.rpc('daemon.listSessions', {}) as Array<{ id: string; cmd: string; state: string }>;
      // Map to same shape as local PTYManager.getActiveInstances()
      return sessions
        .filter(s => s.state !== 'dead')
        .map(s => ({ id: s.id, shell: s.cmd }));
    }));
  } else {
    ipcMain.handle(IPC.PTY_LIST, wrapHandler(IPC.PTY_LIST, () => {
      return ptyManager.getActiveInstances();
    }));
  }

  // pty:reconnect
  ipcMain.removeHandler(IPC.PTY_RECONNECT);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_RECONNECT, wrapHandler(IPC.PTY_RECONNECT, async (_event: Electron.IpcMainInvokeEvent, id: string) => {
      try {
        const sessions = await daemonClient.rpc('daemon.listSessions', {}) as Array<{ id: string; cmd: string; state: string }>;
        const session = sessions.find(s => s.id === id);
        if (!session || session.state === 'dead') {
          return { success: false, error: 'Session not found or dead' };
        }

        // Ensure attached and session pipe connected
        await daemonClient.rpc('daemon.attachSession', { id });
        await daemonClient.connectSessionPipe(id);

        // Set up data forwarding. Routed through the per-id helper so a
        // repeat reconnect (e.g. AppLayout's reconcile firing again on the
        // late daemon.onConnected event) replaces the prior listener instead
        // of stacking a duplicate that doubles every byte the PTY emits.
        const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
          if (payload.sessionId !== id) return;
          const win = getWindow?.();
          if (win && !win.isDestroyed()) {
            const text = decodeSessionData(id, payload.data);
            if (text) win.webContents.send(IPC.PTY_DATA, id, text);
          }
        };
        setSessionDataListener(id, onSessionData as (...args: unknown[]) => void);

        return { success: true, id: session.id, shell: session.cmd };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }));
  } else {
    ipcMain.handle(IPC.PTY_RECONNECT, wrapHandler(IPC.PTY_RECONNECT, (_event: Electron.IpcMainInvokeEvent, id: string) => {
      const instance = ptyManager.get(id);
      if (!instance) {
        return { success: false, error: 'PTY not found' };
      }
      return { success: true, id: instance.id, shell: instance.shell };
    }));
  }

  // Listen for daemon session:died events and forward to renderer
  let onDaemonSessionDied: ((payload: { sessionId: string; exitCode: number | null }) => void) | null = null;
  if (useDaemon && daemonClient) {
    onDaemonSessionDied = (payload: { sessionId: string; exitCode: number | null }) => {
      const win = getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, payload.sessionId, payload.exitCode ?? -1);
      }
      daemonClient.disconnectSessionPipe(payload.sessionId).catch(() => {});
    };
    daemonClient.on('session:died', onDaemonSessionDied);
  }

  // Cleanup function
  return () => {
    ipcMain.removeHandler(IPC.PTY_CREATE);
    ipcMain.removeAllListeners(IPC.PTY_WRITE);
    ipcMain.removeHandler(IPC.PTY_RESIZE);
    ipcMain.removeHandler(IPC.PTY_DISPOSE);
    ipcMain.removeHandler(IPC.PTY_LIST);
    ipcMain.removeHandler(IPC.PTY_RECONNECT);

    // Clean up daemon listeners
    if (daemonClient) {
      for (const listener of daemonSessionListeners.values()) {
        daemonClient.removeListener('session:data', listener);
      }
      daemonSessionListeners.clear();
      if (onDaemonSessionDied) {
        daemonClient.removeListener('session:died', onDaemonSessionDied);
      }
    }
  };
}
