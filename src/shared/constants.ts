// IPC Channel names
export const IPC = {
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_DISPOSE: 'pty:dispose',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
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
  // Phase 4: Auto updater
  UPDATE_CHECK: 'update:check',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_NOT_AVAILABLE: 'update:not-available',
  UPDATE_ERROR: 'update:error',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
} as const;

// Named Pipe path for wmux API
// In production, PID is appended at runtime for security isolation
export const PIPE_NAME = '\\\\.\\pipe\\wmux';

export function getPipeName(): string {
  return `${PIPE_NAME}-${globalThis.process?.pid ?? 0}`;
}

// Environment variable names injected into PTY sessions
export const ENV_KEYS = {
  WORKSPACE_ID: 'WMUX_WORKSPACE_ID',
  SURFACE_ID: 'WMUX_SURFACE_ID',
  SOCKET_PATH: 'WMUX_SOCKET_PATH',
  AUTH_TOKEN: 'WMUX_AUTH_TOKEN',
} as const;
