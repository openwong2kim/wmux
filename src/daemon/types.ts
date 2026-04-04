// === Daemon-specific type definitions ===

/** Session lifecycle state */
export type DaemonSessionState = 'detached' | 'attached' | 'dead' | 'suspended';

/** Per-session metadata persisted to sessions.json */
export interface DaemonSession {
  id: string;
  state: DaemonSessionState;
  createdAt: string;        // ISO 8601
  lastActivity: string;     // ISO 8601
  pid: number;              // child process PID
  cmd: string;              // executed command
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  agent?: {
    role: string;
    teamId: string;
    displayName: string;
  };
  exitCode?: number | null;
  exitSignal?: string | null;
  deadTtlHours: number;
  bufferDumpPath?: string;
}

/** Top-level schema for ~/.wmux/sessions.json */
export interface DaemonState {
  version: number;
  sessions: DaemonSession[];
}

/** Daemon configuration (~/.wmux/config.json) */
export interface DaemonConfig {
  version: number;
  daemon: {
    pipeName: string;
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    autoStart: boolean;
  };
  session: {
    defaultShell: string;
    defaultCols: number;
    defaultRows: number;
    bufferSizeMb: number;
    bufferMaxMb: number;
    deadSessionTtlHours: number;
    deadSessionDumpBuffer: boolean;
  };
}
