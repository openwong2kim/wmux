// IPC Channel names
export const IPC = {
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_DISPOSE: 'pty:dispose',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_LIST: 'pty:list',
  PTY_RECONNECT: 'pty:reconnect',
  // X8 pane supervision. PTY_RESTARTED fires when the daemon's PaneSupervisor
  // re-created a session under the SAME id with a fresh PTY (a supervised
  // restart). Distinct from PTY_EXIT — the renderer must re-attach the
  // existing reconnect machinery, NOT run the died-path cleanup. Payload:
  // { ptyId, restartCount, exitCode }.
  PTY_RESTARTED: 'pty:restarted',
  // X8 — sticky supervision status flip (runaway-guard trip → 'stopped',
  // manual rearm/stop). Always forwarded for badge sync; main also raises an
  // OS toast on guard trips only. Payload: { ptyId, status, reason, restartCount }.
  SUPERVISION_CHANGED: 'supervision:changed',
  // X8 — renderer → main invoke channels for the supervision control surface
  // (pane context menu rearm / stop). Renderer-only by design: only the user
  // re-arms a tripped guard, never an external MCP/CLI client. Forwarded to
  // the daemon's renderer-only daemon.superviseRearm / daemon.superviseStop.
  SUPERVISE_REARM: 'supervise:rearm',
  SUPERVISE_STOP: 'supervise:stop',
  // Fires once per attach, after the daemon SessionPipe's ring-buffer
  // flush completes. Payload: (sessionId, recoveredBytes). The renderer
  // uses recoveredBytes>0 as the signal to wipe its .txt-cache replay
  // before letting the live PTY output compose on a clean buffer.
  PTY_FLUSH_COMPLETE: 'pty:flush-complete',
  SHELL_LIST: 'shell:list',
  FONTS_LIST: 'fonts:list',
  SESSION_SAVE: 'session:save',
  SESSION_LOAD: 'session:load',
  NOTIFICATION: 'notification:new',
  // X2 — OS toast click → jump to the originating pane. Main sends the
  // toast's {ptyId, workspaceId} context; renderer resolves and activates
  // the workspace/pane/surface (see useNotificationListener).
  NOTIFICATION_FOCUS: 'notification:focus',
  CWD_CHANGED: 'notification:cwd-changed',
  GIT_BRANCH_CHANGED: 'notification:git-branch-changed',
  TERMINAL_TITLE_CHANGED: 'terminal:title-changed',
  METADATA_UPDATE: 'metadata:update',
  METADATA_REQUEST: 'metadata:request',
  // Phase 3: RPC bridge (Main ↔ Renderer)
  RPC_COMMAND: 'rpc:command',
  RPC_RESPONSE: 'rpc:response',
  // Clipboard (main process bridge)
  CLIPBOARD_WRITE: 'clipboard:write',
  CLIPBOARD_READ: 'clipboard:read',
  CLIPBOARD_READ_IMAGE: 'clipboard:read-image',
  CLIPBOARD_HAS_IMAGE: 'clipboard:has-image',
  // Phase 4: Auto updater
  UPDATE_CHECK: 'update:check',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_NOT_AVAILABLE: 'update:not-available',
  UPDATE_ERROR: 'update:error',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  // Settings sync (renderer → main)
  TOAST_ENABLED: 'settings:toast-enabled',
  AUTO_UPDATE_ENABLED: 'settings:auto-update-enabled',
  // Agent critical action approval
  APPROVAL_REQUEST: 'approval:request',
  // Phase 2.2 — MCP plugin permission approval (main → renderer subscribe,
  // renderer → main response). Emitted when the enforcer rejects an
  // unconfirmed plugin in enforce mode and the ApprovalQueue mints a
  // prompt. The renderer's PermissionApprovalDialog renders the prompt
  // and sends the user's decision back over PERMISSION_PROMPT_RESOLVE.
  PERMISSION_PROMPT_OPEN: 'permission:prompt-open',
  PERMISSION_PROMPT_RESOLVE: 'permission:prompt-resolve',
  // Main → renderer push fired from INSIDE ApprovalQueue.resolvePrompt AND
  // cancelPrompt the moment a prompt leaves the queue (resolved by the modal,
  // the pluginHost deadlock-break, or a coalesced sibling). Lets the renderer
  // approval-inbox remove the row. Payload: { promptId }.
  PERMISSION_PROMPT_CLOSED: 'permission:prompt-closed',
  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  // Open an absolute filesystem path in the OS default app / explorer.
  // Triggered by Ctrl+click on a path token rendered in the terminal.
  // Path is validated main-side: must be absolute, no NUL bytes, length-capped.
  SHELL_OPEN_PATH: 'shell:open-path',
  GIT_STATUS: 'git:status',
  DIALOG_PICK_FILE: 'dialog:pick-file',
  // File system
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_WATCH: 'fs:watch',
  FS_UNWATCH: 'fs:unwatch',
  FS_CHANGED: 'fs:changed',
  // Scrollback persistence
  SCROLLBACK_DUMP: 'scrollback:dump',
  SCROLLBACK_LOAD: 'scrollback:load',
  // Claude Code hook signal health (Phase 1.5). Push channel — main process
  // emits whenever SignalLatencyMeter stats change (throttled to 1Hz in
  // registerHooksRpc). Payload: LatencyStats snapshot. Renderer subscribes
  // via preload `signalHealth.onUpdate` and feeds uiSlice.setHookSignalHealth.
  SIGNAL_HEALTH_UPDATE: 'signal-health:update',
  // Anthropic 5h/7d usage meter (Phase 2). Push channel — UsagePoller in
  // main process emits whenever its state changes (initial fetch, hourly
  // tick, manual refresh, 401, network error). Payload: PollerState.
  // Renderer subscribes via preload `usage.onUpdate` and feeds
  // uiSlice.setAnthropicUsage.
  USAGE_UPDATE: 'usage:update',
  // Renderer → main: opt-in / opt-out toggle for the Anthropic usage
  // meter (Settings → Claude 연동 → Anthropic 사용량 표기 토글). Main
  // starts/stops the UsagePoller on receipt.
  USAGE_TOGGLE: 'usage:toggle',
  // Renderer → main: manual refresh (StatusBar mini widget / Settings
  // "지금 새로고침" button). Triggers an immediate poll regardless of
  // interval timing. Caller enforces a UI-side cooldown (5 min).
  USAGE_REFRESH: 'usage:refresh',
  // EventBus publish — renderer→main one-way for pane lifecycle events
  EVENTS_PUBLISH: 'events:publish',
  // Total app memory (renderer → main, invoke). Returns the summed
  // workingSetSize (RSS) across the whole Electron process tree in bytes.
  // Replaces the renderer-only performance.memory.usedJSHeapSize, which only
  // measured the renderer V8 JS heap (~10MB) and grossly under-reported usage.
  APP_MEMORY: 'app:memory',
  // Window control
  WINDOW_HIDE: 'window:hide',
  // Windows taskbar attention recall. Renderer asks main to flash the
  // taskbar entry when an unfocused window receives a notification (T6 of
  // the Notification System Expansion). `on=true` starts the flash;
  // `on=false` clears it. Main also auto-clears on the BrowserWindow
  // `'focus'` event so a user clicking the window dismisses the flash
  // even if the renderer never sends `false`.
  WINDOW_FLASH_FRAME: 'window:flashFrame',
  // MCP integration status / management (Settings panel + CLI parity)
  MCP_CHECK: 'mcp:check',
  MCP_REREGISTER: 'mcp:reregister',
  MCP_UNREGISTER: 'mcp:unregister',
  // First-run wizard (Plan 1.15) — magical-moment onboarding flow
  FIRST_RUN_CHECK: 'first-run:check',
  FIRST_RUN_COMPLETE: 'first-run:complete',
  FIRST_RUN_DISMISS: 'first-run:dismiss',
  FIRST_RUN_REOPEN: 'first-run:reopen',
  FIRST_RUN_REGISTER_MCP: 'first-run:register-mcp',
  FIRST_RUN_START_SAMPLE_TASK: 'first-run:start-sample-task',
  // First-run wizard event channels (renderer-side `on()` listeners)
  FIRST_RUN_SAMPLE_TASK_READY: 'first-run:sample-task-ready',
  FIRST_RUN_SAMPLE_TASK_TIMEOUT: 'first-run:sample-task-timeout',
  // Plugin host (B-1). PLUGINS_LIST returns loaded UI plugin summaries +
  // load failures; PLUGINS_RPC forwards a validated bridge request from a
  // plugin iframe through the shared RpcRouter (clientName pinned main-side).
  PLUGINS_LIST: 'plugins:list',
  PLUGINS_RPC: 'plugins:rpc',
  // Renderer-initiated approval prompt for an unconfirmed plugin. Without
  // this, UI plugins dead-lock: the host only mounts trusted iframes, an
  // unmounted iframe makes no RPCs, and the Phase 2.2 approval prompt only
  // fires on a rejected RPC. Resolves with { approved } after the user
  // answers the standard PermissionApprovalDialog.
  PLUGINS_REQUEST_APPROVAL: 'plugins:request-approval',
  // Main → renderer push for `ui.decoratePane` — payload PluginPaneDecoration.
  PLUGIN_PANE_DECORATION: 'plugins:pane-decoration',
  // Project config (X5 wmux.json). GET resolves a workspace cwd to the nearest
  // wmux.json (repo-boundary walk) + its trust state; SET_TRUST persists a
  // user decision bound to the content hash the approval UI displayed.
  PROJECT_CONFIG_GET: 'project-config:get',
  PROJECT_CONFIG_SET_TRUST: 'project-config:set-trust',
} as const;

// Daemon process exit codes. A spawned daemon that finds the canonical control
// pipe already owned by a LIVE daemon exits with this distinct code (rather than
// a generic failure) so the launcher reconnects to the existing daemon instead
// of looping into another spawn — the duplicate-daemon / split-brain fix
// (Defect 3 / Step ③). 75 mirrors sysexits.h EX_TEMPFAIL: "try again", and is
// well clear of Node's own 1/2/9-ish fatal codes.
export const DAEMON_EXIT_ALREADY_RUNNING = 75;

// 인스턴스 격리용 경로 suffix. main 프로세스가 dev 빌드(!app.isPackaged)에서
// WMUX_DATA_SUFFIX='-dev'를 설정하고, daemon은 spawn 시 env로 이를 상속한다.
// 이 헬퍼를 모든 소켓/토큰/디렉토리 경로에 적용해, dev 빌드와 packaged 빌드(또는
// 다른 체크아웃의 빌드)가 같은 SingletonLock·소켓·~/.wmux를 두고 충돌하지 않게
// 한다. 미설정(packaged 기본) 시 빈 문자열이라 기존 경로와 100% 동일.
export function dataSuffix(): string {
  return process.env.WMUX_DATA_SUFFIX || '';
}

// Named Pipe / Unix socket path for wmux API
// Fixed name so MCP clients (e.g. Claude Code) can reconnect across wmux restarts
export function getPipeName(): string {
  if (process.platform === 'win32') {
    // Use os.userInfo() instead of process.env.USERNAME — env vars may not
    // be inherited by MCP subprocesses spawned by Claude Code
    const username = require('os').userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux${dataSuffix()}-${username}`;
  }
  const home = require('os').homedir() || '/tmp';
  return `${home}/.wmux${dataSuffix()}.sock`;
}

// Environment variable names injected into PTY sessions
export const ENV_KEYS = {
  WORKSPACE_ID: 'WMUX_WORKSPACE_ID',
  SURFACE_ID: 'WMUX_SURFACE_ID',
  // X6 ③: the daemon session id of the pane, injected by the daemon at spawn
  // (DaemonSessionManager.createSession). Unlike SURFACE_ID — which the renderer
  // never supplies at pty.create time because a surface is minted AFTER the pty
  // exists — the daemon always knows its own session id, so this is the one
  // per-pane identifier that reliably reaches the child shell (and the Claude
  // hook bridge). Lets a hook attribute its capture to the EXACT pane instead of
  // collapsing to the workspace's active surface (split-pane / shared-cwd fix).
  PTY_ID: 'WMUX_PTY_ID',
  SOCKET_PATH: 'WMUX_SOCKET_PATH',
  AUTH_TOKEN: 'WMUX_AUTH_TOKEN',
  SHELL_HOOK: 'WMUX_SHELL_HOOK',
  SHELL_HOOK_ACTIVE: 'WMUX_SHELL_HOOK_ACTIVE',
} as const;

// Auth token file path — written by wmux main process, read by MCP server
export function getAuthTokenPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux${dataSuffix()}-auth-token`;
}

// PID-to-workspace mapping directory — written by PTYManager, read by MCP server
// to resolve workspace identity when env vars don't propagate through Claude Code
export function getPidMapDir(): string {
  return `${getWmuxHomeDir()}/pid-map`;
}

// TCP port file path — written by PipeServer, read by MCP clients as fallback
// when Windows named pipe EPERM blocks direct pipe connections
export function getTcpPortPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux${dataSuffix()}-tcp-port`;
}

// wmux user home directory — root for plugin-trust.json, pid-map/, and other
// substrate state that needs to survive across wmux restarts. Single source
// of truth so callers don't reimplement the USERPROFILE/HOME dance.
export function getWmuxHomeDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux${dataSuffix()}`;
}

// Plugin trust database — see `docs/api/mcp-plugin-spec.md`. Written by main
// process via `PluginTrustStore` (atomicWriteJSON). NOT a secret — it stores
// declared identities and user-issued trust grants, not credentials.
export function getPluginTrustPath(): string {
  return `${getWmuxHomeDir()}/plugin-trust.json`;
}
