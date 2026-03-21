process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});

import { app, BrowserWindow, powerMonitor } from 'electron';
import started from 'electron-squirrel-startup';
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

if (started) {
  app.quit();
}

// Prevent multiple instances — focus existing window instead
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
    cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow);
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
        cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow);
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
registerBrowserRpc(rpcRouter, () => mainWindow);

app.on('ready', () => {
  console.log('[Main] App ready, creating window...');
  mainWindow = createWindow();
  console.log('[Main] Window created:', !!mainWindow);

  attachWindowRecovery(mainWindow);

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
  pipeServer.start();
  const authToken = pipeServer.getAuthToken();
  mcpRegistrar.register(authToken);
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
  ptyManager.disposeAll();
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
