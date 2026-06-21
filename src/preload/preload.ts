import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/constants';
import type {
  FirstRunCheckResult,
  RegisterMcpResult,
  SampleTaskStartPayload,
} from '../shared/firstRun';
import { isFileDrag } from '../shared/dragDrop';
import type { ResumeBinding } from '../shared/agentResume';
import type {
  RemoteInboxItem,
  LanLinkStatus,
  LanLinkConfigurePatch,
  LanLinkPairBeginResult,
  LanLinkPairingStatus,
  LanLinkPairJoinArgs,
  LanLinkJoinResult,
  LanLinkSendArgs,
  LanLinkPeersListResult,
} from '../shared/lanlink';

/** Mirrors {@link McpStatusPayload} in src/main/ipc/handlers/mcp.handler.ts. */
export interface McpTargetStatusPayload {
  id: string;
  displayName: string;
  format: 'json' | 'toml';
  configPath: string;
  configExists: boolean;
  configModified: string | null;
  verified: boolean;
  wmux: { registered: boolean; path: string | null };
}
interface McpStatusPayload {
  targets: McpTargetStatusPayload[];
}

const electronAPI = {
  // OS-aware shortcut mapping support — renderer cannot read process.platform
  // directly under sandbox + contextIsolation, so expose it here.
  // 'win32' | 'darwin' | 'linux' | 'aix' | 'freebsd' | 'openbsd' | 'sunos' | 'cygwin' | 'netbsd'
  platform: process.platform as NodeJS.Platform,
  pty: {
    // `exec`/`supervision` (X8): set by the AppLayout funnel for a supervised
    // wmux.json leaf — `exec` runs the command as the pane's ROOT process and
    // `supervision` arms the daemon's PaneSupervisor (daemon mode only; the
    // local branch ignores them with a one-time warning toast).
    create: (options?: { shell?: string; cwd?: string; cols?: number; rows?: number; workspaceId?: string; surfaceId?: string; env?: Record<string, string>; initialCommand?: string; exec?: string; supervision?: { restart: 'on-failure' | 'always'; limit?: { burst?: number; healthyUptimeSec?: number } } }) =>
      ipcRenderer.invoke(IPC.PTY_CREATE, options),
    write: (id: string, data: string) => {
      ipcRenderer.send(IPC.PTY_WRITE, id, data);
    },
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.PTY_RESIZE, id, cols, rows),
    dispose: (id: string) =>
      ipcRenderer.invoke(IPC.PTY_DISPOSE, id),
    // `supervision` (X8) is additive and present only on supervised daemon-mode
    // sessions — the renderer uses it to hydrate its supervision slice on boot
    // and daemon-reconnect. Absent in local mode and for unsupervised panes.
    list: () =>
      ipcRenderer.invoke(IPC.PTY_LIST) as Promise<{ id: string; shell: string; supervision?: { status: 'armed' | 'stopped'; restartCount: number }; resumeAgent?: string; resumeBinding?: ResumeBinding }[]>,
    reconnect: (id: string) =>
      // RCA A1 — `transient` distinguishes a recoverable failure (pipe not
      // writable yet, RPC threw during a handler-swap window) from a permanent
      // one (session genuinely dead). The renderer retries transient failures
      // instead of immediately clearing the ptyId and replacing the session.
      ipcRenderer.invoke(IPC.PTY_RECONNECT, id) as Promise<{ success: boolean; id?: string; shell?: string; error?: string; code?: string; transient?: boolean }>,
    onData: (callback: (id: string, data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data);
      ipcRenderer.on(IPC.PTY_DATA, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY_DATA, listener); };
    },
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode);
      ipcRenderer.on(IPC.PTY_EXIT, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY_EXIT, listener); };
    },
    // X8 — a supervised session was re-created under the same id with a fresh
    // PTY. The renderer prints an in-pane restart marker and re-attaches via
    // its reconnect machinery (useTerminal). Distinct from onExit: a restart is
    // NOT a death, so the died-path teardown must not run.
    onRestarted: (callback: (payload: { ptyId: string; restartCount: number; exitCode: number | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { ptyId: string; restartCount: number; exitCode: number | null }) =>
        callback(payload);
      ipcRenderer.on(IPC.PTY_RESTARTED, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY_RESTARTED, listener); };
    },
    // X8 — sticky supervision status changed (guard trip → 'stopped', manual
    // rearm/stop). Drives the pane/sidebar supervision badge. The guard-trip
    // toast is raised main-side; this channel is for in-app badge sync.
    onSupervisionChanged: (callback: (payload: { ptyId: string; status: 'armed' | 'stopped'; reason: 'guard-trip' | 'rearm' | 'manual-stop'; restartCount: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { ptyId: string; status: 'armed' | 'stopped'; reason: 'guard-trip' | 'rearm' | 'manual-stop'; restartCount: number }) =>
        callback(payload);
      ipcRenderer.on(IPC.SUPERVISION_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.SUPERVISION_CHANGED, listener); };
    },
    // Fires once per attach when the daemon's SessionPipe ring-buffer
    // flush completes. recoveredBytes is the exact byte count replayed
    // from the daemon's scrollback before the FLUSH_DONE_MARKER. 0 means
    // mismatch case (cap-skipped session or fresh create) — useTerminal
    // uses this to decide whether to keep its .txt-cache replay on
    // screen or wipe it for the daemon-authoritative replay.
    onFlushComplete: (callback: (id: string, recoveredBytes: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, recoveredBytes: number) =>
        callback(id, recoveredBytes);
      ipcRenderer.on(IPC.PTY_FLUSH_COMPLETE, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY_FLUSH_COMPLETE, listener); };
    },
  },
  // X8 supervision control (renderer-only, pane context menu). `rearm` resets a
  // tripped runaway guard and restarts the pane once; `stop` disarms it. Both
  // resolve `{ ok }` (false in local mode / for an unknown id). Only the user
  // drives these — external MCP/CLI clients are gated out daemon-side.
  supervise: {
    rearm: (ptyId: string) => ipcRenderer.invoke(IPC.SUPERVISE_REARM, ptyId) as Promise<{ ok: boolean }>,
    stop: (ptyId: string) => ipcRenderer.invoke(IPC.SUPERVISE_STOP, ptyId) as Promise<{ ok: boolean }>,
  },
  shell: {
    list: () => ipcRenderer.invoke(IPC.SHELL_LIST) as Promise<{ name: string; path: string; args?: string[] }[]>,
    openExternal: (url: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url) as Promise<void>,
    // Open an absolute filesystem path in the OS default app / explorer.
    // Backed by Electron's shell.openPath; main validates the path is
    // absolute, length-capped, and free of NUL bytes. Resolves with
    // { ok, error? } — on `ok=false` main has already revealed the parent
    // folder via showItemInFolder, so the renderer typically ignores it.
    openPath: (filePath: string) =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, filePath) as Promise<{ ok: boolean; error?: string }>,
  },
  fonts: {
    // Best-effort list of installed font-family names for the Settings font
    // picker. Always resolves (never rejects); resolves [] on non-Windows or
    // any enumeration failure. The font input is free-text, so [] just means
    // "no autocomplete suggestions".
    list: () => ipcRenderer.invoke(IPC.FONTS_LIST) as Promise<string[]>,
  },
  session: {
    save: (data: unknown) => ipcRenderer.invoke(IPC.SESSION_SAVE, data),
    load: () => ipcRenderer.invoke(IPC.SESSION_LOAD),
  },
  system: {
    /**
     * Total app memory (bytes) across the whole Electron process tree —
     * main + GPU + every renderer + utility processes. Backed by
     * app.getAppMetrics() in main. Replaces the old renderer-only
     * performance.memory.usedJSHeapSize, which reported just this renderer's
     * V8 JS heap (~10MB) and under-reported real usage by ~10x.
     */
    getMemoryUsage: () => ipcRenderer.invoke(IPC.APP_MEMORY) as Promise<number>,
  },
  settings: {
    setToastEnabled: (enabled: boolean) => ipcRenderer.send(IPC.TOAST_ENABLED, enabled),
    setAutoUpdateEnabled: (enabled: boolean) => ipcRenderer.send(IPC.AUTO_UPDATE_ENABLED, enabled),
  },
  notification: {
    // ptyId may be null for app-level notifications (e.g. external MCP
    // `notify` RPC, where no PTY originates the message). When null, the
    // renderer resolves via `data.workspaceId` or falls back to the active
    // workspace.
    onNew: (callback: (ptyId: string | null, data: { type: string; title: string; body: string; workspaceId?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string | null, data: { type: string; title: string; body: string; workspaceId?: string }) =>
        callback(ptyId, data);
      ipcRenderer.on(IPC.NOTIFICATION, listener);
      return () => { ipcRenderer.removeListener(IPC.NOTIFICATION, listener); };
    },
    // X2 — OS toast click → pane jump. Main sends the toast's originating
    // context after restoring/focusing the window; the renderer resolves
    // ptyId → workspace/pane/surface (or workspaceId → workspace) and
    // activates it. Unresolvable ids are a silent no-op.
    onFocusRequest: (callback: (payload: { ptyId: string | null; workspaceId: string | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { ptyId: string | null; workspaceId: string | null }) =>
        callback(payload);
      ipcRenderer.on(IPC.NOTIFICATION_FOCUS, listener);
      return () => { ipcRenderer.removeListener(IPC.NOTIFICATION_FOCUS, listener); };
    },
    onCwdChanged: (callback: (ptyId: string, cwd: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, cwd: string) =>
        callback(ptyId, cwd);
      ipcRenderer.on(IPC.CWD_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.CWD_CHANGED, listener); };
    },
    onGitBranchChanged: (callback: (ptyId: string, branch: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, branch: string) =>
        callback(ptyId, branch);
      ipcRenderer.on(IPC.GIT_BRANCH_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.GIT_BRANCH_CHANGED, listener); };
    },
    onTitleChanged: (callback: (ptyId: string, title: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, title: string) =>
        callback(ptyId, title);
      ipcRenderer.on(IPC.TERMINAL_TITLE_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.TERMINAL_TITLE_CHANGED, listener); };
    },
  },
  metadata: {
    request: (ptyId: string) =>
      ipcRenderer.invoke(IPC.METADATA_REQUEST, ptyId),
    // Single discriminated payload (MetadataUpdatePayload). All main-process
    // metadata channels (CWD/git polling, agent status, meta.rpc status/
    // progress) flow through this one shape. Renderer routes by ptyId
    // (preferred) or workspaceId (for surface-less updates like
    // meta.setStatus on the active workspace).
    onUpdate: (callback: (payload: { ptyId?: string; workspaceId?: string; gitBranch?: string; cwd?: string; listeningPorts?: number[]; agentStatus?: string; agentName?: string; status?: string; progress?: number; gitIsWorktree?: boolean; pr?: { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; checks: 'pending' | 'passing' | 'failing' | null; url: string } | null; lastNotificationText?: { ts: number; title: string | null; body: string; source: 'osc9' | 'osc777' | 'osc99' }; activity?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { ptyId?: string; workspaceId?: string; gitBranch?: string; cwd?: string; listeningPorts?: number[]; agentStatus?: string; agentName?: string; status?: string; progress?: number; gitIsWorktree?: boolean; pr?: { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; checks: 'pending' | 'passing' | 'failing' | null; url: string } | null; lastNotificationText?: { ts: number; title: string | null; body: string; source: 'osc9' | 'osc777' | 'osc99' }; activity?: string }) =>
        callback(payload);
      ipcRenderer.on(IPC.METADATA_UPDATE, listener);
      return () => { ipcRenderer.removeListener(IPC.METADATA_UPDATE, listener); };
    },
    // gate로 확정된 agentName을 main 캐시에서 pull. running 수신 시 agentName이
    // 비어 있으면 호출해, 매핑 준비 전에 놓친 1회성 session:agent emit을 메운다.
    resolveAgent: (ptyId: string) =>
      ipcRenderer.invoke('detection:resolveAgent', ptyId) as Promise<string | null>,
  },
  rpc: {
    onCommand: (
      callback: (requestId: string, method: string, params: Record<string, unknown>) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        requestId: string,
        method: string,
        params: Record<string, unknown>,
      ) => callback(requestId, method, params);
      ipcRenderer.on(IPC.RPC_COMMAND, listener);
      return () => { ipcRenderer.removeListener(IPC.RPC_COMMAND, listener); };
    },
    respond: (requestId: string, result: unknown) =>
      ipcRenderer.send(`${IPC.RPC_RESPONSE}:${requestId}`, result),
  },
  browser: {
    registerWebview: (surfaceId: string, webContentsId: number) =>
      ipcRenderer.invoke('browser:register-webview', surfaceId, webContentsId),
  },
  fs: {
    readDir: (dirPath: string) => ipcRenderer.invoke(IPC.FS_READ_DIR, dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke(IPC.FS_READ_FILE, filePath) as Promise<string | null>,
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke(IPC.FS_WRITE_FILE, filePath, content) as Promise<boolean>,
    watch: (dirPath: string) => ipcRenderer.invoke(IPC.FS_WATCH, dirPath),
    unwatch: (dirPath: string) => ipcRenderer.invoke(IPC.FS_UNWATCH, dirPath),
    onChanged: (callback: (dirPath: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dirPath: string) => callback(dirPath);
      ipcRenderer.on(IPC.FS_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.FS_CHANGED, listener); };
    },
  },
  git: {
    status: (cwd: string) => ipcRenderer.invoke(IPC.GIT_STATUS, cwd) as Promise<string>,
  },
  dialog: {
    pickFile: () => ipcRenderer.invoke(IPC.DIALOG_PICK_FILE) as Promise<string[]>,
  },
  // Project config (X5 wmux.json). `get` resolves a workspace cwd to the
  // nearest wmux.json + trust state; `setTrust` persists a user decision
  // bound to the contentHash the approval dialog displayed.
  projectConfig: {
    get: (cwd: string) =>
      ipcRenderer.invoke(IPC.PROJECT_CONFIG_GET, cwd) as Promise<import('../shared/wmuxProjectConfig').ProjectConfigState>,
    setTrust: (root: string, decision: 'trusted' | 'denied' | 'clear', contentHash?: string) =>
      ipcRenderer.invoke(IPC.PROJECT_CONFIG_SET_TRUST, root, decision, contentHash) as Promise<{ ok: boolean }>,
  },
  // Plugin host (B-1). `list` returns loaded UI plugin summaries + load
  // failures; `rpc` forwards a host-validated bridge request from a plugin
  // iframe to main, where it dispatches through the shared RpcRouter with
  // clientName pinned to the plugin (full permission enforcement applies).
  plugins: {
    list: () => ipcRenderer.invoke(IPC.PLUGINS_LIST) as Promise<{
      plugins: unknown[];
      failures: Array<{ name: string; errors: string[] }>;
    }>,
    rpc: (pluginName: string, method: string, params?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.PLUGINS_RPC, pluginName, method, params) as Promise<unknown>,
    requestApproval: (pluginName: string) =>
      ipcRenderer.invoke(IPC.PLUGINS_REQUEST_APPROVAL, pluginName) as Promise<{ approved: boolean }>,
    onPaneDecoration: (callback: (decoration: {
      plugin: string;
      paneId: string;
      badge: string | null;
      tooltip?: string;
      color?: string;
    }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, decoration: Parameters<typeof callback>[0]) => callback(decoration);
      ipcRenderer.on(IPC.PLUGIN_PANE_DECORATION, listener);
      return () => { ipcRenderer.removeListener(IPC.PLUGIN_PANE_DECORATION, listener); };
    },
  },
  daemon: {
    onConnected: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('daemon:connected', listener);
      return () => { ipcRenderer.removeListener('daemon:connected', listener); };
    },
    // Phase A — A6. Companion to onConnected. The renderer subscribes to
    // both so its reactive daemon-mode state machine can update when the
    // daemon drops out at runtime (e.g., daemon process dies), not only
    // when it appears for the first time. Used to gate the .txt scrollback
    // write/load IPCs so local-mode users keep their fallback path.
    onDisconnected: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('daemon:disconnected', listener);
      return () => { ipcRenderer.removeListener('daemon:disconnected', listener); };
    },
    // Issue #54. Respawn-loop telemetry — fired before each backoff so the
    // renderer can show a "Daemon reconnecting (attempt N)…" toast/badge
    // instead of leaving the user with a silent local-only degrade.
    onReconnecting: (callback: (info: { attempt: number; backoffMs: number }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, info: { attempt: number; backoffMs: number }) => callback(info);
      ipcRenderer.on('daemon:reconnecting', listener);
      return () => { ipcRenderer.removeListener('daemon:reconnecting', listener); };
    },
    // Fires once a respawned client is healthy again. Distinct from
    // `onConnected` so the renderer can choose to show recovery UX
    // (e.g. "Daemon reconnected — sessions restored") rather than the
    // cold-boot path.
    onReconnected: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('daemon:reconnected', listener);
      return () => { ipcRenderer.removeListener('daemon:reconnected', listener); };
    },
    // Budget exhausted — user should be told the app is permanently in
    // local-only mode for this session and that restarting wmux will
    // attempt a fresh daemon launch.
    onRespawnExhausted: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('daemon:respawn-exhausted', listener);
      return () => { ipcRenderer.removeListener('daemon:respawn-exhausted', listener); };
    },
    /**
     * Resolves once main has finalized the daemon-vs-local decision.
     * Returns `{ connected: bool }` reflecting the CURRENT state at
     * invoke time (so a renderer reloaded after the daemon disconnected
     * mid-session sees the live answer, not a stale "connected at
     * startup" record).
     *
     * Implemented as `ipcRenderer.invoke` rather than a one-shot event
     * listener so renderers created after main already decided — for
     * example, the `mainWindow.reload()` paths used by renderer crash
     * recovery — can still query the state on demand. An event-based
     * promise would deadlock here because the event was already
     * consumed by the previous (now-destroyed) preload instance.
     */
    whenReady: (): Promise<{ connected: boolean }> =>
      ipcRenderer.invoke('daemon:get-ready-state') as Promise<{ connected: boolean }>,
  },
  mcp: {
    check: () => ipcRenderer.invoke(IPC.MCP_CHECK) as Promise<McpStatusPayload>,
    reregister: () => ipcRenderer.invoke(IPC.MCP_REREGISTER) as Promise<McpStatusPayload>,
    unregister: () => ipcRenderer.invoke(IPC.MCP_UNREGISTER) as Promise<McpStatusPayload>,
  },
  firstRun: {
    check: () => ipcRenderer.invoke(IPC.FIRST_RUN_CHECK) as Promise<FirstRunCheckResult>,
    complete: () => ipcRenderer.invoke(IPC.FIRST_RUN_COMPLETE) as Promise<void>,
    dismiss: () => ipcRenderer.invoke(IPC.FIRST_RUN_DISMISS) as Promise<void>,
    reopen: () => ipcRenderer.invoke(IPC.FIRST_RUN_REOPEN) as Promise<FirstRunCheckResult>,
    registerMcp: () => ipcRenderer.invoke(IPC.FIRST_RUN_REGISTER_MCP) as Promise<RegisterMcpResult>,
    startSampleTask: (payload: SampleTaskStartPayload) =>
      ipcRenderer.invoke(IPC.FIRST_RUN_START_SAMPLE_TASK, payload) as Promise<void>,
    onSampleTaskReady: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.FIRST_RUN_SAMPLE_TASK_READY, listener);
      return () => { ipcRenderer.removeListener(IPC.FIRST_RUN_SAMPLE_TASK_READY, listener); };
    },
    onSampleTaskTimeout: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.FIRST_RUN_SAMPLE_TASK_TIMEOUT, listener);
      return () => { ipcRenderer.removeListener(IPC.FIRST_RUN_SAMPLE_TASK_TIMEOUT, listener); };
    },
  },
  // Phase 1.5 — Claude Code plugin signal-health push. Main fires whenever
  // SignalLatencyMeter stats change (throttled to 1Hz). Payload mirrors
  // `LatencyStats` from src/main/hooks/SignalLatencyMeter.ts. Mirrored here
  // to avoid a renderer→main type import; renderer uses the structural
  // shape only.
  signalHealth: {
    onUpdate: (
      callback: (stats: {
        total: number;
        count: number;
        p50: number | null;
        p95: number | null;
        lastSignalAt: number | null;
        perAgent: Record<string, number>;
        workspaceMatchRate: { matched: number; missed: number };
      }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        stats: {
          total: number;
          count: number;
          p50: number | null;
          p95: number | null;
          lastSignalAt: number | null;
          perAgent: Record<string, number>;
          workspaceMatchRate: { matched: number; missed: number };
        },
      ) => callback(stats);
      ipcRenderer.on(IPC.SIGNAL_HEALTH_UPDATE, listener);
      return () => { ipcRenderer.removeListener(IPC.SIGNAL_HEALTH_UPDATE, listener); };
    },
  },
  // Phase 2 — Anthropic 5h/7d usage meter. Push channel from UsagePoller.
  // Shape mirrors `PollerState` from src/main/claude/UsagePoller.ts.
  // The renderer treats the snapshot as opaque: it's read but never
  // mutated, and the access token is intentionally absent from the
  // payload (the poller strips it before emitting).
  usage: {
    onUpdate: (
      callback: (state: {
        status:
          | 'idle'
          | 'ok'
          | 'token-missing'
          | 'unauthorized'
          | 'http-error'
          | 'network-error'
          | 'read-error';
        snapshot: {
          sessionPct: number;
          sessionResetEpochSec: number;
          weeklyPct: number;
          weeklyResetEpochSec: number;
          fetchedAtMs: number;
        } | null;
        lastError: string | null;
        subscriptionType: string | null;
      }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<typeof callback>[0],
      ) => callback(state);
      ipcRenderer.on(IPC.USAGE_UPDATE, listener);
      return () => { ipcRenderer.removeListener(IPC.USAGE_UPDATE, listener); };
    },
    /** Toggle the poller on/off. Persisted in uiSlice and synced to
     *  main on every change. Main starts/stops the interval. */
    setEnabled: (enabled: boolean) => ipcRenderer.send(IPC.USAGE_TOGGLE, enabled),
    /** Manual refresh. UI is responsible for the 5-minute cooldown. */
    refresh: () => ipcRenderer.send(IPC.USAGE_REFRESH),
  },
  window: {
    hide: () => ipcRenderer.send(IPC.WINDOW_HIDE),
    // T6 Notification System Expansion — recall the user via the Windows
    // taskbar attention flash (dock bounce on macOS) when a notification
    // arrives while the window is unfocused. Main-side guard:
    // `BrowserWindow.isDestroyed()` is checked before the native call, so
    // post-shutdown sends are silently dropped. Main also clears the flash
    // automatically on `'focus'`, so callers do not need to send a paired
    // `flashFrame(false)` after the user reacts.
    flashFrame: (on: boolean) => {
      ipcRenderer.send(IPC.WINDOW_FLASH_FRAME, on);
    },
  },
  events: {
    /**
     * One-way publish of a pane lifecycle event to the main-process EventBus.
     * Caller passes a partial event object (`type`, `workspaceId`, plus
     * type-specific fields); main stamps `seq` and `ts`. Failures are
     * swallowed — telemetry must never break a state mutation.
     */
    publish: (input: { type: string; workspaceId: string; [k: string]: unknown }) =>
      ipcRenderer.send(IPC.EVENTS_PUBLISH, input),
  },
  scrollback: {
    dump: (surfaceId: string, content: string) =>
      ipcRenderer.invoke(IPC.SCROLLBACK_DUMP, surfaceId, content),
    load: (surfaceId: string) =>
      ipcRenderer.invoke(IPC.SCROLLBACK_LOAD, surfaceId) as Promise<string | null>,
  },
  updater: {
    checkForUpdates: () =>
      ipcRenderer.invoke(IPC.UPDATE_CHECK) as Promise<{ status: string }>,
    installUpdate: () =>
      ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onUpdateAvailable: (callback: (data: { status: string; releaseName?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string; releaseName?: string }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, listener); };
    },
    onUpdateNotAvailable: (callback: (data: { status: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_NOT_AVAILABLE, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_NOT_AVAILABLE, listener); };
    },
    onUpdateError: (callback: (data: { status: string; message: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string; message: string }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_ERROR, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_ERROR, listener); };
    },
    onUpdateProgress: (callback: (data: { status: string; percent: number | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string; percent: number | null }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_DOWNLOAD, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_DOWNLOAD, listener); };
    },
  },
};

// File drag-and-drop: capture in preload where File.path is accessible
const fileDropCallbacks: ((paths: string[]) => void)[] = [];

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = webUtils.getPathForFile(files[i]);
      if (filePath) paths.push(filePath);
    }
    if (paths.length > 0) {
      fileDropCallbacks.forEach((cb) => cb(paths));
    }
  });
});

(electronAPI as Record<string, unknown>).onFileDrop = (callback: (paths: string[]) => void) => {
  fileDropCallbacks.push(callback);
  return () => {
    const idx = fileDropCallbacks.indexOf(callback);
    if (idx >= 0) fileDropCallbacks.splice(idx, 1);
  };
};

// Phase 2.2 — MCP plugin permission approval bridge.
// Main fires PERMISSION_PROMPT_OPEN with the ApprovalPromptInfo payload
// when an unconfirmed plugin needs the user's approval; the renderer's
// PermissionApprovalDialog renders it and sends the decision back via
// PERMISSION_PROMPT_RESOLVE. Both channels are shape-validated downstream
// so a stale renderer can't corrupt the queue.
(electronAPI as Record<string, unknown>).permissionPrompt = {
  onOpen: (
    callback: (info: {
      promptId: string;
      clientName: string;
      declaredCapabilities: string[];
      rationale?: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, info: Parameters<typeof callback>[0]) => callback(info);
    ipcRenderer.on(IPC.PERMISSION_PROMPT_OPEN, listener);
    return () => {
      ipcRenderer.removeListener(IPC.PERMISSION_PROMPT_OPEN, listener);
    };
  },
  resolve: (promptId: string, approved: boolean) =>
    ipcRenderer.invoke(IPC.PERMISSION_PROMPT_RESOLVE, {
      promptId,
      approved,
    }) as Promise<{ ok: boolean; error?: string }>,
  onClosed: (callback: (payload: { promptId: string }) => void) => {
    const listener = (_event: unknown, payload: { promptId: string }) => callback(payload);
    ipcRenderer.on(IPC.PERMISSION_PROMPT_CLOSED, listener);
    return () => {
      ipcRenderer.removeListener(IPC.PERMISSION_PROMPT_CLOSED, listener);
    };
  },
};

// LanLink PR-2 — dedicated channel for materialized read-only REMOTE inbox
// items. Mirrors the permissionPrompt bridge: main pushes over IPC.LANLINK_REMOTE
// and the renderer's useRemoteInboxBridge projects into the remoteInbox slice.
// A dedicated channel (NOT RPC_COMMAND) keeps a remote message structurally
// unable to reach submitToPty / the a2a execute funnel.
(electronAPI as Record<string, unknown>).lanlink = {
  onRemote: (callback: (item: RemoteInboxItem) => void) => {
    const listener = (_event: unknown, item: RemoteInboxItem) => callback(item);
    ipcRenderer.on(IPC.LANLINK_REMOTE, listener);
    return () => {
      ipcRenderer.removeListener(IPC.LANLINK_REMOTE, listener);
    };
  },
  // Renderer → main replay request. Fire AFTER the onRemote listener is
  // installed so main re-pulls the full inbox from cursor 0 (reload / cold-start
  // recovery; the renderer's isNew guard dedups).
  requestResync: () => {
    ipcRenderer.send(IPC.LANLINK_RESYNC);
  },
  // LanLink PR-3 control plane (Settings → LanLink section). Request/response via
  // invoke (mirrors mcp). status reads daemon enable/NIC state + live NICs;
  // configure applies a partial enable/NIC update and echoes the new status.
  status: () => ipcRenderer.invoke(IPC.LANLINK_STATUS) as Promise<LanLinkStatus>,
  configure: (patch: LanLinkConfigurePatch) =>
    ipcRenderer.invoke(IPC.LANLINK_CONFIGURE, patch) as Promise<LanLinkStatus>,
  // LanLink PR-5 pairing/peer control plane (Settings → LanLink pairing section).
  // Outbound-only (pair/send) + read-only queries; structurally unable to reach a
  // local PTY. Extends THIS literal in place (never a second .lanlink assignment).
  pairBegin: () => ipcRenderer.invoke(IPC.LANLINK_PAIR_BEGIN) as Promise<LanLinkPairBeginResult>,
  pairStatus: () => ipcRenderer.invoke(IPC.LANLINK_PAIR_STATUS) as Promise<LanLinkPairingStatus>,
  pairCancel: () => ipcRenderer.invoke(IPC.LANLINK_PAIR_CANCEL) as Promise<{ ok: true }>,
  pairJoin: (args: LanLinkPairJoinArgs) =>
    ipcRenderer.invoke(IPC.LANLINK_PAIR_JOIN, args) as Promise<LanLinkJoinResult>,
  send: (args: LanLinkSendArgs) =>
    ipcRenderer.invoke(IPC.LANLINK_SEND, args) as Promise<{ ok: true }>,
  peersList: () => ipcRenderer.invoke(IPC.LANLINK_PEERS_LIST) as Promise<LanLinkPeersListResult>,
  peersRemove: (peerUuid: string) =>
    ipcRenderer.invoke(IPC.LANLINK_PEERS_REMOVE, peerUuid) as Promise<{ ok: true }>,
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

/**
 * clipboardAPI — bridge to Electron's clipboard module.
 *
 * IMPORTANT (renderer contract):
 *   `writeText` MAY throw. The main-process handler validates input, enforces
 *   a size cap, and surfaces clipboard-lock failures via thrown errors with
 *   one of these codes attached: CLIPBOARD_TOO_LARGE, CLIPBOARD_INVALID_TYPE,
 *   CLIPBOARD_WRITE_FAILED. Callers MUST `await` and `try/catch` so the user
 *   can be notified and the source selection preserved for retry.
 */
contextBridge.exposeInMainWorld('clipboardAPI', {
  /**
   * Write `text` to the system clipboard. Resolves on success, REJECTS with a
   * coded Error on validation/size/lock failure (see header above).
   */
  writeText: (text: string) => ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text) as Promise<void>,
  readText: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ) as Promise<string>,
  readImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ_IMAGE) as Promise<string | null>,
  hasImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_HAS_IMAGE) as Promise<boolean>,
});

export type ElectronAPI = typeof electronAPI;
