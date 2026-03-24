process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});

import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { createWindow } from './window/createWindow';
import { PTYManager } from './pty/PTYManager';
import { PTYBridge } from './pty/PTYBridge';
import { registerAllHandlers } from './ipc/registerHandlers';
import { RpcRouter } from './pipe/RpcRouter';
import { PipeServer } from './pipe/PipeServer';
import { registerWorkspaceRpc } from './pipe/handlers/workspace.rpc';
import { registerSurfaceRpc } from './pipe/handlers/surface.rpc';
import { registerPaneRpc } from './pipe/handlers/pane.rpc';
import { registerInputRpc } from './pipe/handlers/input.rpc';
import { registerNotifyRpc } from './pipe/handlers/notify.rpc';
import { registerMetaRpc } from './pipe/handlers/meta.rpc';
import { registerSystemRpc } from './pipe/handlers/system.rpc';
import { registerBrowserRpc } from './pipe/handlers/browser.rpc';
import { AutoUpdater } from './updater/AutoUpdater';
import { McpRegistrar } from './mcp/McpRegistrar';
import { WebviewCdpManager } from './browser-session/WebviewCdpManager';
import { DaemonClient, getDaemonPipeName, readDaemonAuthToken } from './DaemonClient';
import { ensureDaemon } from './daemon/launcher';

// Force English for Chromium internal messages to avoid encoding corruption
// on non-ASCII locales (e.g. Korean Windows where cp949 garbles console output).
app.commandLine.appendSwitch('lang', 'en-US');

// CDP (Chrome DevTools Protocol) remote debugging
let cdpPort = 0;
if (process.env.WMUX_DISABLE_CDP !== 'true') {
  // Randomize port within range to prevent predictable scanning
  const basePort = 18800;
  const range = 100;
  cdpPort = basePort + Math.floor(Math.random() * range);
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort.toString());
  console.log(`[WinMux] CDP enabled on port ${cdpPort}`);
}

// Handle Squirrel installer events directly.
// electron-squirrel-startup spawns Update.exe and waits for 'close' before
// calling app.quit(), which races with the synchronous app.quit() that follows.
// This caused the installer to hang. Instead we just exit immediately —
// Squirrel itself creates/removes shortcuts via Update.exe before launching us.
if (process.platform === 'win32') {
  const squirrelCmd = process.argv[1];
  if (
    squirrelCmd === '--squirrel-install' ||
    squirrelCmd === '--squirrel-updated' ||
    squirrelCmd === '--squirrel-uninstall' ||
    squirrelCmd === '--squirrel-obsolete'
  ) {
    console.log(`[Squirrel] handling ${squirrelCmd}, exiting immediately`);
    app.quit();
    process.exit(0);
  }
}

// Prevent multiple instances — focus existing window instead
const gotLock = app.requestSingleInstanceLock();
console.log('[DEBUG] gotLock =', gotLock);
if (!gotLock) {
  console.log('[DEBUG] failed to get single instance lock, quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const ptyManager = new PTYManager();
let mainWindow: BrowserWindow | null = null;
const ptyBridge = new PTYBridge(ptyManager, () => mainWindow);
const autoUpdater = new AutoUpdater(() => mainWindow);

const rpcRouter = new RpcRouter();
const pipeServer = new PipeServer(rpcRouter);
const mcpRegistrar = new McpRegistrar();
const webviewCdpManager = new WebviewCdpManager(cdpPort);

// Daemon client — initialized on app ready, used if daemon is available
let daemonClient: DaemonClient | null = null;

let cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow);

// Module-scope crash tracking so activate-created windows share the same counters
let lastCrashTime = 0;
let crashCount = 0;

function attachWindowRecovery(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer crashed:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    if (now - lastCrashTime < 5000) {
      crashCount++;
    } else {
      crashCount = 1;
    }
    lastCrashTime = now;
    if (crashCount >= 3) {
      require('electron').dialog.showErrorBox('wmux', 'Renderer crashed repeatedly. Please restart.');
      app.quit();
      return;
    }
    cleanupHandlers();
    cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient ?? undefined);
    const activePtys = ptyManager.getActiveInstances();
    console.log(`[Main] ${activePtys.length} PTY(s) still alive — reloading renderer`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 1000);
  });

  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  win.on('unresponsive', () => {
    console.warn('[Main] Renderer is unresponsive');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.warn('[Main] Renderer still unresponsive after 10s — reloading');
        cleanupHandlers();
        cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient ?? undefined);
        mainWindow.reload();
      }
    }, 10_000);
  });

  win.on('responsive', () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      console.log('[Main] Renderer recovered from unresponsive state');
    }
  });
}

registerWorkspaceRpc(rpcRouter, () => mainWindow);
registerSurfaceRpc(rpcRouter, () => mainWindow);
registerPaneRpc(rpcRouter, () => mainWindow);
registerInputRpc(rpcRouter, ptyManager, () => mainWindow);
registerNotifyRpc(rpcRouter, () => mainWindow);
registerMetaRpc(rpcRouter, () => mainWindow);
registerSystemRpc(rpcRouter);
registerBrowserRpc(rpcRouter, () => mainWindow, webviewCdpManager);

// IPC: webview CDP registration
ipcMain.handle('browser:register-webview', async (_event, surfaceId: string, webContentsId: number) => {
  await webviewCdpManager.register(surfaceId, webContentsId);
  return { ok: true };
});

console.log('[DEBUG] registering app.on(ready)');
app.on('ready', async () => {
  console.log('[Main] App ready, creating window...');
  mainWindow = createWindow();
  console.log('[Main] Window created:', !!mainWindow);

  attachWindowRecovery(mainWindow);

  // Auto-start daemon and connect
  try {
    const daemonInfo = await ensureDaemon();
    console.log(`[Main] Daemon ${daemonInfo.spawned ? 'spawned' : 'found'} (PID: ${daemonInfo.pid})`);

    const client = new DaemonClient(daemonInfo.pipeName, daemonInfo.authToken);
    const connected = await client.connect();
    if (connected) {
      let authOk = false;
      try {
        await client.rpc('daemon.ping', {});
        authOk = true;
      } catch {
        console.warn('[Main] Daemon auth failed after spawn, falling back to local PTY');
        await client.disconnect().catch(() => {});
      }
      if (authOk) {
        daemonClient = client;
        console.log('[Main] Connected to wmux-daemon (auth verified)');
        cleanupHandlers();
        cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient);
        daemonClient.on('disconnected', () => {
          console.warn('[Main] Daemon disconnected, falling back to local PTY');
          daemonClient = null;
          cleanupHandlers();
          cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow);
        });
      }
    }
  } catch (err) {
    console.warn('[Main] Daemon auto-start failed, using local PTY:', err);
  }

  // Handle system sleep/wake — verify PTY processes survived
  powerMonitor.on('resume', () => {
    console.log('[Main] System resumed from sleep — checking PTY health');
    const active = ptyManager.getActiveInstances();
    for (const { id } of active) {
      const instance = ptyManager.get(id);
      if (!instance) continue;
      try {
        // Check if process is still alive (signal 0 = no signal, just check)
        process.kill(instance.process.pid, 0);
      } catch {
        // Process is dead — clean up
        console.warn(`[Main] PTY ${id} (pid ${instance.process.pid}) died during sleep`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:exit', id, -1);
        }
        ptyBridge.cleanupInstance(id);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Main] Page failed to load:', errorCode, errorDescription);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 2000);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded successfully');
  });
  // Write auth token BEFORE starting pipe server — prevents race where
  // MCP client reads old token while new pipe is already listening
  const authToken = pipeServer.getAuthToken();
  mcpRegistrar.register(authToken);
  pipeServer.start();
  autoUpdater.start();
});

app.on('window-all-closed', () => {
  app.quit();
});

let isQuitting = false;
app.on('before-quit', async (e) => {
  if (isQuitting) return; // second pass — let quit proceed
  e.preventDefault();
  isQuitting = true;

  // Attempt session save from renderer
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    try {
      await mainWindow.webContents.executeJavaScript(
        `try { window.dispatchEvent(new Event('beforeunload')); } catch(e) {}`
      );
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch {
      // Renderer unavailable — rely on last periodic save
    }
  }

  cleanupHandlers();

  if (daemonClient?.isConnected) {
    // Daemon mode: detach only — sessions persist in daemon
    console.log('[Main] Daemon mode — detaching sessions (not killing)');
    await daemonClient.disconnect();
    daemonClient = null;
  } else {
    // Local mode: kill all PTYs
    ptyManager.disposeAll();
  }

  webviewCdpManager.disposeAll();
  pipeServer.stop();
  mcpRegistrar.unregister();
  autoUpdater.stop();

  app.quit(); // re-trigger quit — isQuitting flag skips preventDefault
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    attachWindowRecovery(mainWindow);
  }
});
