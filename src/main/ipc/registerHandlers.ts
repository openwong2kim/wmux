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
import { registerDiffHandlers } from './handlers/diff.handler';
import { registerMcpHandlers } from './handlers/mcp.handler';
import { registerLanLinkHandlers } from './handlers/lanlink.handler';
import { createFlashFrameHandler } from '../window/flashFrame';
import { IPC } from '../../shared/constants';
import { toastManager } from '../pipe/handlers/notify.rpc';
import { eventBus } from '../events/EventBus';
import { WMUX_EVENT_TYPES, type WmuxEventType } from '../../shared/events';
import { VALID_TRANSITIONS, type TaskState } from '../../shared/types';

const EVENT_TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

// --- a2a.task publish trust boundary ---
// `from`/`to` become the dual-party scoping key in the events.poll filter
// (events.rpc.ts), so they MUST be well-formed before they reach the ring.
// The allowed-value sets are derived from the canonical TaskState enum
// (VALID_TRANSITIONS' keys) and A2aTaskEvent.kind so they can't drift from
// the shared schema.
const A2A_TASK_STATE_SET = new Set<TaskState>(Object.keys(VALID_TRANSITIONS) as TaskState[]);
const A2A_TASK_KIND_SET = new Set<string>(['created', 'updated', 'cancelled']);
/** Upper bound on the sanitized messagePreview length (chars). */
const A2A_PREVIEW_MAX = 200;

/**
 * Build an ALLOW-LISTED a2a.task EmitInput from a renderer-supplied object.
 * Returns null (→ caller drops the publish, no ring entry) when any required
 * field is missing/malformed. Critically:
 *   - `from`/`to`/`taskId` must be non-empty strings (the matcher never
 *     compares undefined; a scope-less entry can never be created).
 *   - `workspaceId` is stamped server-side === `from` — a renderer-supplied
 *     workspaceId is ignored entirely for a2a.task (fail-safe: a consumer that
 *     ignores the type still scopes to the sender, never a third party).
 *   - `state`/`kind` are validated against their enums; an invalid value is a
 *     reject (not a silent coercion) so a forged shape can't smuggle state.
 *   - `messagePreview`, if present, is coerced to a string and truncated.
 *   - `verifiedItemCount`, if present, is included ONLY when a non-negative
 *     integer (§6.M PR-C grade). Strings/negatives/floats/other types are
 *     dropped — a forged or malformed value never rides through onto the event
 *     (this is the boundary Codex flagged: without it the renderer could emit
 *     the field but the server would silently strip it).
 * The renderer object is NEVER spread — only these fields cross the boundary.
 *
 * Exported so the dual-party scoping suite (events.rpc.test.ts) can assert the
 * reject path (missing/empty from/to → null → no ring entry) without standing
 * up the Electron IPC handler. This is the exact predicate `onEventsPublish`
 * uses for `type === 'a2a.task'`.
 */
export function buildA2aTaskEmitInput(
  obj: Record<string, unknown>,
): { type: 'a2a.task'; workspaceId: string; [k: string]: unknown } | null {
  const from = obj['from'];
  const to = obj['to'];
  const taskId = obj['taskId'];
  if (typeof from !== 'string' || from.length === 0) return null;
  if (typeof to !== 'string' || to.length === 0) return null;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;

  const state = obj['state'];
  if (typeof state !== 'string' || !A2A_TASK_STATE_SET.has(state as TaskState)) return null;
  const kind = obj['kind'];
  if (typeof kind !== 'string' || !A2A_TASK_KIND_SET.has(kind)) return null;

  const emit: { type: 'a2a.task'; workspaceId: string; [k: string]: unknown } = {
    type: 'a2a.task',
    // Base workspaceId is stamped server-side === from. Any renderer-supplied
    // workspaceId is ignored.
    workspaceId: from,
    from,
    to,
    taskId,
    state: state as TaskState,
    kind,
  };

  const preview = obj['messagePreview'];
  if (preview !== undefined && preview !== null) {
    emit['messagePreview'] = String(preview).slice(0, A2A_PREVIEW_MAX);
  }

  // §6.M PR-C: verified evidence-item count. Strict — only a non-negative
  // integer crosses. No coercion: a forged string/negative/float/NaN is
  // dropped so it can never masquerade as a grade on the event.
  const verifiedItemCount = obj['verifiedItemCount'];
  if (
    typeof verifiedItemCount === 'number' &&
    Number.isInteger(verifiedItemCount) &&
    verifiedItemCount >= 0
  ) {
    emit['verifiedItemCount'] = verifiedItemCount;
  }

  return emit;
}

export interface RegisterHandlersOptions {
  /** McpRegistrar instance shared with main/index — exposes Settings MCP IPC. */
  mcpRegistrar?: McpRegistrar;
  /** Lazy accessor for the live pipe-server auth token, used by mcp:reregister. */
  getMcpAuthToken?: () => string | null;
  /**
   * Renderer-initiated RPC entrypoint. Wired in main/index to the live
   * `RpcRouter` so the in-renderer `__wmuxEventsPoll` /
   * `__wmuxChannelsRpc` bridges (installed in `useRpcBridge.ts`) can
   * reach the pipe dispatch layer. The renderer is a trusted
   * first-party surface — no separate capability check runs here; the
   * router's own PermissionEnforcer applies per-method.
   */
  invokeRendererRpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
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
  // J2 — diff:read / diff:applyHunks. git 전용(데몬 무관) — 항상 등록.
  const cleanupDiff = registerDiffHandlers();
  const cleanupMcp = options.mcpRegistrar
    ? registerMcpHandlers(options.mcpRegistrar, options.getMcpAuthToken ?? (() => null))
    : null;
  // LanLink PR-3 control plane — daemon-mode only (the enable/NIC state lives in
  // the daemon). Without a DaemonClient there is no control pipe to forward to, so
  // the handlers stay unregistered and the Settings section hides itself.
  const cleanupLanLink = daemonClient ? registerLanLinkHandlers(daemonClient) : null;

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

  // Bridge redesign — theme-following titleBarOverlay restyle. The custom
  // titlebar (renderer) sends the active theme's mantle/sub colors whenever
  // the theme changes so the native Windows window controls stay coherent
  // with the chrome. Trust boundary: only #RGB/#RRGGBB strings pass — a
  // malformed payload must never reach the native call (it throws).
  // setTitleBarOverlay exists only when the window was created with
  // titleBarOverlay (Windows); guarded so macOS/Linux are silent no-ops.
  const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const onSetTitleBarOverlay = (_event: Electron.IpcMainEvent, opts: unknown): void => {
    if (process.platform !== 'win32') return;
    if (!opts || typeof opts !== 'object') return;
    const { color, symbolColor } = opts as { color?: unknown; symbolColor?: unknown };
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) return;
    if (typeof symbolColor !== 'string' || !HEX_COLOR.test(symbolColor)) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 36 });
    } catch {
      // Window created without titleBarOverlay (e.g. future flag/rollback) —
      // restyling is cosmetic, never let it crash main.
    }
  };
  ipcMain.removeAllListeners(IPC.WINDOW_SET_TITLEBAR_OVERLAY);
  ipcMain.on(IPC.WINDOW_SET_TITLEBAR_OVERLAY, onSetTitleBarOverlay);

  // EventBus publish from renderer (one-way). Validates the event type and
  // workspaceId at the trust boundary so a misbehaving renderer can't poison
  // the ring with arbitrary shapes; type-specific fields ride through as-is.
  const onEventsPublish = (_event: Electron.IpcMainEvent, input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const obj = input as Record<string, unknown>;
    const type = obj['type'];
    if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type as WmuxEventType)) return;

    // a2a.task is the access-control anchor: `from`/`to` are the dual-party
    // scoping key (events.rpc.ts), so this type gets a dedicated, ALLOW-LISTED
    // construction BEFORE emit — we never spread the renderer object and never
    // trust a renderer-supplied workspaceId (it is stamped === from). A
    // missing/malformed from/to/taskId/state/kind drops the publish with no
    // ring entry. This runs before the generic non-empty-workspaceId gate
    // below because a2a.task derives its workspaceId from `from`, not the
    // renderer field.
    if (type === 'a2a.task') {
      const emit = buildA2aTaskEmitInput(obj);
      if (!emit) return;
      try {
        eventBus.emit(emit);
      } catch {
        // Telemetry must not crash the IPC channel — swallow and move on.
      }
      return;
    }

    const workspaceId = obj['workspaceId'];
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return;
    try {
      eventBus.emit({ ...obj, type: type as WmuxEventType, workspaceId });
    } catch {
      // Telemetry must not crash the IPC channel — swallow and move on.
    }
  };
  ipcMain.removeAllListeners(IPC.EVENTS_PUBLISH);
  ipcMain.on(IPC.EVENTS_PUBLISH, onEventsPublish);

  // Renderer-initiated RPC bridge. The renderer is a trusted first-party
  // surface (its preload is the same process the user is running) — the
  // pipe RpcRouter's PermissionEnforcer runs on dispatch, so the
  // capability gate is identical to what an external pipe client gets.
  // Method/params are sanitized up front: an object-typed params is
  // required (the router validates this too) and method must be a
  // non-empty string. Returns the dispatch result verbatim so the
  // renderer's bridge can project success/error the same way a pipe
  // client would.
  const onRpcInvoke = async (
    _event: Electron.IpcMainInvokeEvent,
    method: unknown,
    params: unknown,
  ): Promise<unknown> => {
    if (typeof method !== 'string' || method.length === 0) {
      return { ok: false, error: 'rpc:invoke: missing method' };
    }
    const safeParams =
      params !== undefined && params !== null && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};
    if (!options.invokeRendererRpc) {
      return { ok: false, error: 'rpc:invoke: renderer RPC bridge not wired' };
    }
    return options.invokeRendererRpc(method, safeParams);
  };
  // RPC_INVOKE is an ipcMain.handle() handler, NOT an .on() listener — it must
  // be cleared with removeHandler(), not removeAllListeners() (which is a no-op
  // for handle handlers). Without this, the SECOND registerAllHandlers() (on a
  // daemon reconnect/respawn) threw "Attempted to register a second handler for
  // 'rpc:invoke'", which aborted the connect bootstrap BEFORE it re-wired the
  // DaemonNotificationRouter onto the new DaemonClient — silently killing every
  // daemon→main EventBus tee (channel.message live delivery, agent.lifecycle, …)
  // until an app restart.
  ipcMain.removeHandler(IPC.RPC_INVOKE);
  ipcMain.handle(IPC.RPC_INVOKE, onRpcInvoke);

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
    cleanupDiff();
    if (cleanupMcp) cleanupMcp();
    if (cleanupLanLink) cleanupLanLink();
    // Mirror the register-side removeHandler so a teardown leaves no stale
    // handle behind (handle handlers are not .on listeners — see above).
    ipcMain.removeHandler(IPC.RPC_INVOKE);
    ipcMain.removeAllListeners(IPC.TOAST_ENABLED);
    ipcMain.removeAllListeners(IPC.WINDOW_HIDE);
    ipcMain.removeAllListeners(IPC.WINDOW_FLASH_FRAME);
  };
}
