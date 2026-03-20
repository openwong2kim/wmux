process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});

import { app, BrowserWindow } from 'electron';
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

const ptyManager = new PTYManager();
let mainWindow: BrowserWindow | null = null;
const ptyBridge = new PTYBridge(ptyManager, () => mainWindow);
const autoUpdater = new AutoUpdater(() => mainWindow);

const rpcRouter = new RpcRouter();
const pipeServer = new PipeServer(rpcRouter);
const mcpRegistrar = new McpRegistrar();

const cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow);
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Main] Page failed to load:', code, desc);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded successfully');
  });
  pipeServer.start();
  const authToken = pipeServer.getAuthToken();
  ptyManager.setAuthToken(authToken);
  mcpRegistrar.register(authToken);
  autoUpdater.start();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  cleanupHandlers();
  ptyManager.disposeAll();
  pipeServer.stop();
  mcpRegistrar.unregister();
  autoUpdater.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});
