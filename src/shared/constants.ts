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
  // Fires once per attach, after the daemon SessionPipe's ring-buffer
  // flush completes. Payload: (sessionId, recoveredBytes). The renderer
  // uses recoveredBytes>0 as the signal to wipe its .txt-cache replay
  // before letting the live PTY output compose on a clean buffer.
  PTY_FLUSH_COMPLETE: 'pty:flush-complete',
  SHELL_LIST: 'shell:list',
  SESSION_SAVE: 'session:save',
  SESSION_LOAD: 'session:load',
  NOTIFICATION: 'notification:new',
  CWD_CHANGED: 'notification:cwd-changed',
  GIT_BRANCH_CHANGED: 'notification:git-branch-changed',
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
  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  // Open an absolute filesystem path in the OS default app / explorer.
  // Triggered by Ctrl+click on a path token rendered in the terminal.
  // Path is validated main-side: must be absolute, no NUL bytes, length-capped.
  SHELL_OPEN_PATH: 'shell:open-path',
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
  // Token tracking
  TOKEN_UPDATE: 'token:update',
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
} as const;

// Named Pipe / Unix socket path for wmux API
// Fixed name so MCP clients (e.g. Claude Code) can reconnect across wmux restarts
export function getPipeName(): string {
  if (process.platform === 'win32') {
    // Use os.userInfo() instead of process.env.USERNAME — env vars may not
    // be inherited by MCP subprocesses spawned by Claude Code
    const username = require('os').userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-${username}`;
  }
  const home = require('os').homedir() || '/tmp';
  return `${home}/.wmux.sock`;
}

// Environment variable names injected into PTY sessions
export const ENV_KEYS = {
  WORKSPACE_ID: 'WMUX_WORKSPACE_ID',
  SURFACE_ID: 'WMUX_SURFACE_ID',
  SOCKET_PATH: 'WMUX_SOCKET_PATH',
  AUTH_TOKEN: 'WMUX_AUTH_TOKEN',
  SHELL_HOOK: 'WMUX_SHELL_HOOK',
  SHELL_HOOK_ACTIVE: 'WMUX_SHELL_HOOK_ACTIVE',
} as const;

// Auth token file path — written by wmux main process, read by MCP server
export function getAuthTokenPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux-auth-token`;
}

// PID-to-workspace mapping directory — written by PTYManager, read by MCP server
// to resolve workspace identity when env vars don't propagate through Claude Code
export function getPidMapDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux/pid-map`;
}

// TCP port file path — written by PipeServer, read by MCP clients as fallback
// when Windows named pipe EPERM blocks direct pipe connections
export function getTcpPortPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux-tcp-port`;
}

// wmux user home directory — root for plugin-trust.json, pid-map/, and other
// substrate state that needs to survive across wmux restarts. Single source
// of truth so callers don't reimplement the USERPROFILE/HOME dance.
export function getWmuxHomeDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux`;
}

// Plugin trust database — see `docs/api/mcp-plugin-spec.md`. Written by main
// process via `PluginTrustStore` (atomicWriteJSON). NOT a secret — it stores
// declared identities and user-issued trust grants, not credentials.
export function getPluginTrustPath(): string {
  return `${getWmuxHomeDir()}/plugin-trust.json`;
}
