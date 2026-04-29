import { ipcMain, type BrowserWindow } from 'electron';
import { PTYManager } from '../pty/PTYManager';
import { PTYBridge } from '../pty/PTYBridge';
import { DaemonClient } from '../DaemonClient';
import { McpRegistrar } from '../mcp/McpRegistrar';
import { registerPTYHandlers } from './handlers/pty.handler';
import { registerSessionHandlers } from './handlers/session.handler';
import { registerShellHandlers } from './handlers/shell.handler';
import { registerMetadataHandlers } from './handlers/metadata.handler';
import { registerClipboardHandlers } from './handlers/clipboard.handler';
import { registerFsHandlers } from './handlers/fs.handler';
import { registerMcpHandlers } from './handlers/mcp.handler';
import { IPC } from '../../shared/constants';
import { toastManager } from '../pipe/handlers/notify.rpc';

export interface RegisterHandlersOptions {
  /** McpRegistrar instance shared with main/index — exposes Settings MCP IPC. */
  mcpRegistrar?: McpRegistrar;
  /** Lazy accessor for the live pipe-server auth token, used by mcp:reregister. */
  getMcpAuthToken?: () => string | null;
}

export function registerAllHandlers(
  ptyManager: PTYManager,
  ptyBridge: PTYBridge,
  getWindow: () => BrowserWindow | null,
  daemonClient?: DaemonClient,
  options: RegisterHandlersOptions = {},
): () => void {
  const cleanupPty = registerPTYHandlers(ptyManager, ptyBridge, daemonClient, getWindow);
  const cleanupSession = registerSessionHandlers();
  const cleanupShell = registerShellHandlers();
  const cleanupMetadata = registerMetadataHandlers(ptyManager, getWindow);
  registerClipboardHandlers();
  const cleanupFs = registerFsHandlers();
  const cleanupMcp = options.mcpRegistrar
    ? registerMcpHandlers(options.mcpRegistrar, options.getMcpAuthToken ?? (() => null))
    : null;

  // Sync toast setting from renderer
  const onToastEnabled = (_event: Electron.IpcMainEvent, enabled: boolean): void => {
    toastManager.enabled = enabled;
  };
  ipcMain.removeAllListeners(IPC.TOAST_ENABLED);
  ipcMain.on(IPC.TOAST_ENABLED, onToastEnabled);

  // Window hide (prefix-d detach)
  const onWindowHide = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.hide();
  };
  ipcMain.removeAllListeners(IPC.WINDOW_HIDE);
  ipcMain.on(IPC.WINDOW_HIDE, onWindowHide);

  return () => {
    cleanupPty();
    cleanupSession();
    cleanupShell();
    cleanupMetadata();
    cleanupFs();
    if (cleanupMcp) cleanupMcp();
    ipcMain.removeAllListeners(IPC.TOAST_ENABLED);
    ipcMain.removeAllListeners(IPC.WINDOW_HIDE);
  };
}
