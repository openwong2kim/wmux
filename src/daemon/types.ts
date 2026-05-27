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
  /** OS boot ID — used to detect reboot and skip PID-based operations on stale sessions */
  bootId?: string;
}

/** Daemon configuration (~/.wmux/config.json) */
export interface DaemonConfig {
  version: number;
  daemon: {
    pipeName: string;
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    autoStart: boolean;
    /**
     * Minutes the daemon waits with zero clients and zero PTY sessions
     * before terminating itself. Defaults to 5. Set to 0 to keep the
     * daemon alive forever (legacy behavior). Useful when a user force-
     * kills the wmux main process and forgets to reopen the UI — the
     * orphaned daemon would otherwise occupy RAM indefinitely.
     */
    idleShutdownMinutes?: number;
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
