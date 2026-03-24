import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PTYManager } from '../../pty/PTYManager';
import { PTYBridge } from '../../pty/PTYBridge';
import { DaemonClient } from '../../DaemonClient';
import { IPC } from '../../../shared/constants';
import { sanitizePtyText } from '../../../shared/types';
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

export function registerPTYHandlers(
  ptyManager: PTYManager,
  ptyBridge: PTYBridge,
  daemonClient?: DaemonClient,
  getWindow?: () => BrowserWindow | null,
): () => void {
  const useDaemon = daemonClient?.isConnected ?? false;

  // Track daemon session:data listeners for cleanup
  const daemonSessionListeners: Array<(...args: unknown[]) => void> = [];

  // pty:create
  ipcMain.removeHandler(IPC.PTY_CREATE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_CREATE, async (_event, options?: { shell?: string; cwd?: string; cols?: number; rows?: number }) => {
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

      // Forward session data to renderer
      const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
        if (payload.sessionId !== sessionId) return;
        const win = getWindow?.();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.PTY_DATA, sessionId, payload.data.toString());
        }
      };
      daemonClient.on('session:data', onSessionData as (...args: unknown[]) => void);
      daemonSessionListeners.push(onSessionData as (...args: unknown[]) => void);

      // Register initial CWD
      updateCwd(sessionId, effectiveCwd);

      return { id: sessionId, shell, cwd: effectiveCwd };
    });
  } else {
    ipcMain.handle(IPC.PTY_CREATE, (_event, options?: { shell?: string; cwd?: string; cols?: number; rows?: number }) => {
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
    });
  }

  // pty:write
  ipcMain.removeAllListeners(IPC.PTY_WRITE);
  if (useDaemon && daemonClient) {
    const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
      if (typeof data !== 'string') return;
      if (data.length > 100_000) return; // prevent mega-writes
      daemonClient.writeToSession(id, sanitizePtyText(data));
    };
    ipcMain.on(IPC.PTY_WRITE, onPtyWrite);
  } else {
    const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
      if (!ptyManager.get(id)) return;
      if (typeof data !== 'string') return;
      if (data.length > 100_000) return;
      ptyManager.write(id, sanitizePtyText(data));
    };
    ipcMain.on(IPC.PTY_WRITE, onPtyWrite);
  }

  // pty:resize
  ipcMain.removeHandler(IPC.PTY_RESIZE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_RESIZE, async (_event, id: string, cols: number, rows: number) => {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
      }
      try {
        await daemonClient.rpc('daemon.resizeSession', { id, cols, rows });
      } catch (err: unknown) {
        // Session may have been destroyed during reconciliation — ignore gracefully
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found') || msg.includes('not exist')) return;
        throw err;
      }
    });
  } else {
    ipcMain.handle(IPC.PTY_RESIZE, (_event, id: string, cols: number, rows: number) => {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
      }
      if (!ptyManager.get(id)) return;
      ptyManager.resize(id, cols, rows);
    });
  }

  // pty:dispose
  ipcMain.removeHandler(IPC.PTY_DISPOSE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_DISPOSE, async (_event, id: string) => {
      await daemonClient.rpc('daemon.destroySession', { id });
      await daemonClient.disconnectSessionPipe(id);
    });
  } else {
    ipcMain.handle(IPC.PTY_DISPOSE, (_event, id: string) => {
      ptyManager.dispose(id);
    });
  }

  // pty:list
  ipcMain.removeHandler(IPC.PTY_LIST);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_LIST, async () => {
      const sessions = await daemonClient.rpc('daemon.listSessions', {}) as Array<{ id: string; cmd: string; state: string }>;
      // Map to same shape as local PTYManager.getActiveInstances()
      return sessions
        .filter(s => s.state !== 'dead')
        .map(s => ({ id: s.id, shell: s.cmd }));
    });
  } else {
    ipcMain.handle(IPC.PTY_LIST, () => {
      return ptyManager.getActiveInstances();
    });
  }

  // pty:reconnect
  ipcMain.removeHandler(IPC.PTY_RECONNECT);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_RECONNECT, async (_event, id: string) => {
      try {
        const sessions = await daemonClient.rpc('daemon.listSessions', {}) as Array<{ id: string; cmd: string; state: string }>;
        const session = sessions.find(s => s.id === id);
        if (!session || session.state === 'dead') {
          return { success: false, error: 'Session not found or dead' };
        }

        // Ensure attached and session pipe connected
        await daemonClient.rpc('daemon.attachSession', { id });
        await daemonClient.connectSessionPipe(id);

        // Set up data forwarding
        const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
          if (payload.sessionId !== id) return;
          const win = getWindow?.();
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC.PTY_DATA, id, payload.data.toString());
          }
        };
        daemonClient.on('session:data', onSessionData as (...args: unknown[]) => void);
        daemonSessionListeners.push(onSessionData as (...args: unknown[]) => void);

        return { success: true, id: session.id, shell: session.cmd };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  } else {
    ipcMain.handle(IPC.PTY_RECONNECT, (_event, id: string) => {
      const instance = ptyManager.get(id);
      if (!instance) {
        return { success: false, error: 'PTY not found' };
      }
      return { success: true, id: instance.id, shell: instance.shell };
    });
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
      for (const listener of daemonSessionListeners) {
        daemonClient.removeListener('session:data', listener);
      }
      if (onDaemonSessionDied) {
        daemonClient.removeListener('session:died', onDaemonSessionDied);
      }
    }
  };
}
