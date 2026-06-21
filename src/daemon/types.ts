// === Daemon-specific type definitions ===

import type { DaemonSupervisionPolicy } from '../shared/rpc';
import type { AgentSlug } from '../shared/events';
import type { ResumeBinding } from '../shared/agentResume';
import type { LanLinkConfig } from '../shared/lanlink';

/** Session lifecycle state */
export type DaemonSessionState = 'detached' | 'attached' | 'dead' | 'suspended';

/**
 * X8 pane supervision — what survives a daemon restart. Policy + the sticky
 * status only: a runaway-guard 'stopped' must NOT silently re-arm across a
 * reboot, while restart counters/backoff state are deliberately volatile
 * (systemd resets start limits on boot; an immediately re-crashing loop
 * trips the guard again within ~a minute).
 */
export interface DaemonSessionSupervision extends DaemonSupervisionPolicy {
  status: 'armed' | 'stopped';
}

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
  /**
   * X8 exec-style unit: `command` runs as the pane's root process via a
   * non-interactive wrapper shell (`cmd` above is that wrapper). Persisted
   * so recovery re-launches the command itself, not an empty shell.
   */
  exec?: { command: string };
  /** X8 supervision policy + sticky status (counters live in PaneSupervisor). */
  supervision?: DaemonSessionSupervision;
  /**
   * X6 resume: canonical slug of the last agent detected running in this
   * session (set from AgentDetector via agentDisplayToSlug). Persisted so that
   * after a reboot the daemon knows an INTERACTIVE pane was running an agent
   * and can offer a one-click resume. Only drives the resume pill for sessions
   * RECOVERED this boot (see recoveredAgentShellIds) — never live reconnects.
   */
  lastDetectedAgent?: AgentSlug;
  /**
   * X6 ③ resume-by-id: the captured handle on this pane's agent conversation
   * (origin session id + cwd + last permission mode), set live from the claude
   * hook via daemon.setResumeBinding and persisted IMMEDIATELY (saveImmediate —
   * same SIGKILL-survival rule as lastDetectedAgent). Drives the EXACT-session
   * resume (`--resume <id>`) on both the recovery pill and the supervised replay.
   */
  resumeBinding?: ResumeBinding;
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
    /**
     * Memory-pressure escalation thresholds in MB, measured against the
     * daemon process RSS. Substrate 3.0 lifecycle Tier-2 floors: as RSS
     * climbs the daemon warns (`memWarnMb`), then GCs DEAD tombstones
     * (`memReapMb`), then refuses new sessions (`memBlockMb`) — it never
     * evicts a live session. `memWarnMb ≤ memReapMb ≤ memBlockMb` is
     * enforced at load time; each has a sane floor and an absolute upper
     * cap (a value above physical RAM can't silently disable protection),
     * and a `memBlockMb` below the floor logs a startup warning rather than
     * silently bricking session creation. Backfilled per-field from
     * defaults when absent/garbage — see `loadConfig` in config.ts.
     *
     * Normalised by `loadConfig`, so they are always present at runtime;
     * a raw config.json may omit them (old files) and gets backfilled.
     */
    memWarnMb: number;
    memReapMb: number;
    memBlockMb: number;
  };
  session: {
    defaultShell: string;
    defaultCols: number;
    defaultRows: number;
    bufferSizeMb: number;
    bufferMaxMb: number;
    deadSessionTtlHours: number;
    deadSessionDumpBuffer: boolean;
    /**
     * Hard cap on concurrent sessions the daemon will hold. New-session
     * creation throws RESOURCE_EXHAUSTED at this ceiling — the substrate
     * refuses, it never evicts an existing session to make room (Tier-2
     * floor, refuse-not-evict). Startup recovery derives its own soft cap
     * as `min(maxSessions, 40)` so a freshly lowered cap can't dead-mark
     * persisted sessions. Backfilled from the default when absent/garbage.
     */
    maxSessions: number;
    /**
     * TTL in hours after which an idle SUSPENDED session tombstone is
     * garbage-collected on the next `StateWriter.load`. This is GC of a
     * tombstone (no live PTY behind it), not eviction of a live session.
     * "Permanent" retention = a large value, never 0. Backfilled from the
     * default when absent/garbage.
     */
    suspendedTtlHours: number;
  };
  /**
   * LanLink control-plane state (PR-3). OPTIONAL — old config.json files predate
   * it and must keep loading, so `validateConfig` deliberately ignores this field
   * and `loadConfig` backfills it per-field to OFF (default `{ enabled:false,
   * nic:null }`) without resetting the rest of the file. `enabled` defaults OFF
   * (explicit opt-in); the NIC is persisted as an identity (name+MAC), never a raw
   * IP. Always present at runtime after `loadConfig` normalises it.
   */
  lanlink?: LanLinkConfig;
}
