// External sessions: coding agents started outside wmux (tmux, screen, zellij,
// ssh into this machine, another terminal app, WSL outside a wmux pane) that
// still report through the wmux hook bridge but have no pane. wmux shows their
// status only; it never shows or types into their terminal.
//
// Data path: hook bridge (AgentSignal, optional `where`) → daemon registry →
// main (IPC push) → renderer store. The daemon owns the registry; the renderer
// only matches a session's cwd to a workspace for placement.

import type { AgentSlug } from './agentIdentity';

export type ExternalSessionState = 'running' | 'needs-you' | 'idle' | 'ended';

/** Where the session lives, from the hook's environment. Every field is a hint. */
export interface ExternalSessionWhere {
  kind: 'tmux' | 'screen' | 'zellij' | 'ssh' | 'terminal' | 'unknown';
  /** tmux / screen / zellij session name, when known. */
  session?: string;
  /** tmux window index, when known. */
  window?: string;
  /** Terminal app (TERM_PROGRAM) for 'terminal', or the ssh client address for 'ssh'. */
  label?: string;
  /** WSL distro name when the agent runs inside WSL (any kind). */
  wslDistro?: string;
}

export interface ExternalSession {
  /** Stable registry key: `${agent}:${agentSessionId}`. */
  id: string;
  agent: AgentSlug;
  agentSessionId: string;
  /** Session title or first prompt, truncated; absent until known. */
  title?: string;
  cwd: string;
  where: ExternalSessionWhere;
  state: ExternalSessionState;
  /** The approval or question text while state is 'needs-you'. */
  pendingQuestion?: string;
  pendingKind?: 'approval' | 'question';
  /** Last tool / activity line, e.g. "Read tests/auth/login.spec.ts". */
  lastActivity?: string;
  /** Unix ms of the last signal from this session. */
  lastSignalAt: number;
  startedAt: number;
  endedAt?: number;
}

/** Text caps applied by the daemon before a session leaves it. */
export const EXTERNAL_SESSION_LIMITS = {
  title: 120,
  pendingQuestion: 500,
  lastActivity: 160,
  whereField: 64,
  /** Most sessions kept; the oldest ended ones go first. */
  maxSessions: 64,
  /** An ended session is dropped this long after it ended. */
  endedTtlMs: 60 * 60 * 1000,
  /** A session with no signal for this long is treated as ended. */
  silentTtlMs: 24 * 60 * 60 * 1000,
} as const;

/** Daemon RPC methods and the push event (daemon → main → renderer). */
export const EXTERNAL_SESSIONS_RPC = {
  list: 'externalSessions.list',
  hide: 'externalSessions.hide',
} as const;
export const EXTERNAL_SESSIONS_CHANGED_EVENT = 'externalSessions.changed';

/** IPC channels between main and the renderer. */
export const EXTERNAL_SESSIONS_IPC = {
  list: 'external-sessions:list',
  hide: 'external-sessions:hide',
  changed: 'external-sessions:changed',
} as const;

/**
 * Renderer API exposed by the preload as `window.electronAPI.externalSessions`.
 * `changed` always carries the full list (it is small), never a delta.
 * `hide` drops the session until it sends a new signal.
 */
export interface ExternalSessionsApi {
  list(): Promise<ExternalSession[]>;
  hide(id: string): Promise<void>;
  onChanged(cb: (sessions: ExternalSession[]) => void): () => void;
}
