import { ipcMain, type BrowserWindow } from 'electron';
import { PTYManager } from '../pty/PTYManager';
import { PTYBridge } from '../pty/PTYBridge';
import { DaemonClient } from '../DaemonClient';
import { McpRegistrar } from '../mcp/McpRegistrar';
import { registerPTYHandlers } from './handlers/pty.handler';
// NOTE: registerSessionHandlers is deliberately NOT imported here. It is
// installed once at module-load from src/main/index.ts and stays alive for
// the entire process lifetime. Including it in `registerAllHandlers` would
// reintroduce the v2.8.1 Bug 3 race class: the daemon-connect handler swap
// (cleanup → re-register) would briefly remove `scrollback:load` and
// `session:load` between the two calls. A renderer mass-mount that fires
// scrollback.load during that microsecond window receives "No handler
// registered" rejections, the silent .catch resolves, and the next 5s
// autosave overwrites the previous scrollback files on disk.
import { registerShellHandlers } from './handlers/shell.handler';
import { registerFontHandlers } from './handlers/fonts.handler';
import { registerMetadataHandlers } from './handlers/metadata.handler';
import { startLocalContextWatch } from '../metadata/localContextWatch';
import { registerClipboardHandlers } from './handlers/clipboard.handler';
import { registerFsHandlers } from './handlers/fs.handler';
import { registerToolbarHandlers } from './handlers/toolbar.handler';
import { registerMcpHandlers } from './handlers/mcp.handler';
import { createFlashFrameHandler } from '../window/flashFrame';
import { IPC } from '../../shared/constants';
import { toastManager } from '../pipe/handlers/notify.rpc';
import { eventBus } from '../events/EventBus';
import { WMUX_EVENT_TYPES, type WmuxEventType } from '../../shared/events';

const EVENT_TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

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
  // session/scrollback handlers: installed elsewhere (module-load in
  // main/index.ts) and intentionally NOT in this swap cycle. See the
  // import-block note above for the race rationale.
  const cleanupShell = registerShellHandlers();
  const cleanupFonts = registerFontHandlers();
  const cleanupMetadata = registerMetadataHandlers(ptyManager, getWindow, {
    // X1: daemon-backed sessions never appear in ptyManager — disable the
    // local liveness prune so daemon-mode cwd/branch caches survive between
    // event-driven updates (cleanup rides session:died via the context router).
    localPtyOwnership: !daemonClient,
  });
  registerClipboardHandlers();
  const cleanupFs = registerFsHandlers();
  const cleanupToolbar = registerToolbarHandlers();
  const cleanupMcp = options.mcpRegistrar
    ? registerMcpHandlers(options.mcpRegistrar, options.getMcpAuthToken ?? (() => null))
    : null;

  // X1 local-mode context watchers (git HEAD fs.watch + PID-tree ports).
  // Daemon mode gets the same data from the daemon process via
  // WorkspaceContextRouter, so this only mounts when main owns the PTYs.
  const cleanupLocalContext = daemonClient ? null : startLocalContextWatch(ptyManager, getWindow);

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

  // Windows taskbar attention recall (T6 of the Notification System
  // Expansion). Renderer fires this from `useNotificationListener` when a
  // notification arrives AND the window is unfocused. The focus auto-clear
  // listener is attached at window construction in `createWindow.ts`, so the
  // renderer is not required to send a matching `flashFrame(false)`.
  const flashFrame = createFlashFrameHandler(getWindow);
  const onFlashFrame = (_event: Electron.IpcMainEvent, on: unknown): void => {
    // Trust boundary — coerce the renderer-supplied payload to boolean
    // instead of forwarding `undefined`/`null`/objects into Electron's
    // native flashFrame, which throws on non-boolean arguments.
    flashFrame(on === true);
  };
  ipcMain.removeAllListeners(IPC.WINDOW_FLASH_FRAME);
  ipcMain.on(IPC.WINDOW_FLASH_FRAME, onFlashFrame);

  // EventBus publish from renderer (one-way). Validates the event type and
  // workspaceId at the trust boundary so a misbehaving renderer can't poison
  // the ring with arbitrary shapes; type-specific fields ride through as-is.
  const onEventsPublish = (_event: Electron.IpcMainEvent, input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const obj = input as Record<string, unknown>;
    const type = obj['type'];
    const workspaceId = obj['workspaceId'];
    if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type as WmuxEventType)) return;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return;
    try {
      eventBus.emit({ ...obj, type: type as WmuxEventType, workspaceId });
    } catch {
      // Telemetry must not crash the IPC channel — swallow and move on.
    }
  };
  ipcMain.removeAllListeners(IPC.EVENTS_PUBLISH);
  ipcMain.on(IPC.EVENTS_PUBLISH, onEventsPublish);

  return () => {
    cleanupPty();
    // cleanupSession deliberately omitted — session/scrollback handlers
    // live outside this swap cycle (see import-block note above).
    cleanupShell();
    cleanupFonts();
    cleanupMetadata();
    if (cleanupLocalContext) cleanupLocalContext();
    cleanupFs();
    cleanupToolbar();
    if (cleanupMcp) cleanupMcp();
    ipcMain.removeAllListeners(IPC.TOAST_ENABLED);
    ipcMain.removeAllListeners(IPC.WINDOW_HIDE);
    ipcMain.removeAllListeners(IPC.WINDOW_FLASH_FRAME);
  };
}
