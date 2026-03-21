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
  SHELL_LIST: 'shell:list',
  SESSION_SAVE: 'session:save',
  SESSION_LOAD: 'session:load',
  NOTIFICATION: 'notification:new',
  CWD_CHANGED: 'notification:cwd-changed',
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
  // Agent critical action approval
  APPROVAL_REQUEST: 'approval:request',
  // File system
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  FS_WATCH: 'fs:watch',
  FS_UNWATCH: 'fs:unwatch',
  FS_CHANGED: 'fs:changed',
} as const;

// Named Pipe / Unix socket path for wmux API
// Fixed name so MCP clients (e.g. Claude Code) can reconnect across wmux restarts
export function getPipeName(): string {
  if (process.platform === 'win32') {
    const username = process.env.USERNAME || 'default';
    return `\\\\.\\pipe\\wmux-${username}`;
  }
  const home = process.env.HOME || '/tmp';
  return `${home}/.wmux.sock`;
}

// Environment variable names injected into PTY sessions
export const ENV_KEYS = {
  WORKSPACE_ID: 'WMUX_WORKSPACE_ID',
  SURFACE_ID: 'WMUX_SURFACE_ID',
  SOCKET_PATH: 'WMUX_SOCKET_PATH',
  AUTH_TOKEN: 'WMUX_AUTH_TOKEN',
} as const;

// Auth token file path — written by wmux main process, read by MCP server
export function getAuthTokenPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux-auth-token`;
}
