// === Daemon-specific type definitions ===

import type { DaemonSupervisionPolicy } from '../shared/rpc';
import type { AgentSlug } from '../shared/events';
import type { ResumeBinding } from '../shared/agentResume';
import type { LanLinkConfig } from '../shared/lanlink';
import type { GateConfig } from './approvals/gateConfig';
import type { NotifySinkConfig } from './push/WebhookSink';
import type { PushPresenceSuppressionConfig } from './push/presence';

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
  /**
   * Daemon-minted identity for this logical session incarnation. Unlike the
   * caller-supplied `id`, this full UUID cannot be reused accidentally. It is
   * replayed across recovery and supervised restarts, but a genuinely new
   * session receives a new value even when its `id` is recycled.
   *
   * Optional only for sessions.json records written before this field existed;
   * createSession always fills it for live sessions.
   */
  incarnationId?: string;
  createdAt: string;        // ISO 8601
  lastActivity: string;     // ISO 8601
  pid: number;              // child process PID
  /**
   * OS-reported creation time of `pid`, as the platform prints it (Windows
   * WMIC `CreationDate`, posix `ps -o lstart=`). Opaque — only ever compared
   * for equality against a fresh reading of the same pid.
   *
   * A pid alone is not an identity: Windows recycles pids aggressively and a
   * tombstone can outlive its shell by `deadTtlHours`, so a later "pid is
   * alive" check can be answering about a completely different process.
   * (pid, pidStartTime) is unique, and #646's reaping paths kill a process
   * tree — they must not fire on a recycled pid.
   *
   * Optional: filled in asynchronously just after spawn (so it is absent for
   * the first moments of a session's life), and absent entirely from records
   * written before this field existed. Consumers must degrade, not guess.
   */
  pidStartTime?: string;
  cmd: string;              // executed command
  /**
   * LIVE working directory. Updated at runtime from the OSC 7 sequences the
   * pane's shell emits, so it follows a `cd` — and so it is whatever any
   * process running in that pane says it is. Fine for a tab tooltip; NOT a
   * directory to act on. Use `spawnCwd` for that.
   */
  cwd: string;
  /**
   * The directory the PTY was actually spawned in. Written once at creation
   * from the resolved spawn parameters and never updated afterwards — in
   * particular the OSC 7 handler that maintains `cwd` does not touch it.
   *
   * Exists because a remote reader (`wmux web`'s diff route) needs a directory
   * that the pane's own process cannot choose. Optional only because a
   * `sessions.json` written before this field existed has no value for it; a
   * recovered session is respawned through `createSession` and gets one.
   */
  spawnCwd?: string;
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

/**
 * Channel retention knobs (`config.json` → `channels`). See
 * `DaemonConfig.channels` for why the two knobs default differently.
 */
export interface ChannelRetentionConfig {
  /** Hours a channel stays in the trash before it is destroyed for good.
   *  `0` = never auto-purge. Default `CHANNEL_TRASH_TTL_HOURS_DEFAULT` (30d). */
  trashTtlHours: number;
  /** Hours after archiving before a channel is moved to the trash on its own.
   *  `0` = OFF (the default) — this is the only knob that discards a record
   *  the operator never chose to discard. */
  autoTrashArchivedHours: number;
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
    /**
     * app-weight P1 idle-CPU knobs (clamped + backfilled like the lifecycle
     * floors above). `livenessIntervalSec`: cadence of the batched tasklist
     * liveness sweep — raising it lowers idle CPU but raises the worst-case
     * supervision death-detection latency (~interval + 13 s of probe
     * budgets). `snapshotIntervalSec`: cadence of the periodic RingBuffer
     * `.buf` dump + sessions.json snapshot (crash-recovery freshness bound).
     */
    livenessIntervalSec?: number;
    snapshotIntervalSec?: number;
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
     * "Permanent" retention = a large value, never 0. Backfilled from
     * the default when absent/garbage.
     */
    suspendedTtlHours: number;
    /**
     * TTL in hours after which an idle DETACHED session (no client
     * attached, shell still alive) is reaped — PTY killed and record
     * removed. Activity is tracked via `lastActivity`, which is bumped on
     * PTY output, so a detached session actively producing output (e.g. a
     * long build) is never reaped; only truly idle unattached shells age
     * out. "Permanent" retention = a large value, never 0. Backfilled from
     * the default when absent/garbage. See #557.
     */
    detachedTtlHours: number;
  };
  /**
   * Channel retention policy. OPTIONAL — old config.json files predate it, so
   * `validateConfig` deliberately ignores this field and `loadConfig` backfills
   * it per-field (the lanlink convention: a malformed slice must not reset the
   * rest of the file).
   *
   * Both knobs are hour counts, and `0` means "never" for both. The pair is
   * split on purpose: `trashTtlHours` only finishes a deletion a human already
   * started, so it ships ON; `autoTrashArchivedHours` is the one that would
   * discard records nobody chose to discard, so it ships OFF.
   */
  channels?: ChannelRetentionConfig;
  /**
   * LanLink control-plane state (PR-3). OPTIONAL — old config.json files predate
   * it and must keep loading, so `validateConfig` deliberately ignores this field
   * and `loadConfig` backfills it per-field to OFF (default `{ enabled:false,
   * nic:null }`) without resetting the rest of the file. `enabled` defaults OFF
   * (explicit opt-in); the NIC is persisted as an identity (name+MAC), never a raw
   * IP. Always present at runtime after `loadConfig` normalises it.
   */
  lanlink?: LanLinkConfig;
  /**
   * Browser automation control. OPTIONAL — old config.json files predate it
   * and must keep loading, so `validateConfig` deliberately ignores this field
   * and `loadConfig` backfills it per-field without resetting the rest of the
   * file (same convention as `lanlink`).
   *
   * `cdp.enabled` controls whether Electron's CDP (Chrome DevTools Protocol)
   * remote-debugging port is opened on boot. CDP is what drives webview-based
   * browser automation (MCP browser tools, screenshots, DOM snapshots). It is
   * enabled by default because that automation is a core feature, but it is
   * the single largest same-user attack surface (loopback socket only — no
   * filesystem or process control needed, unlike other same-user vectors).
   * Disabling it (config `browser.cdp.enabled = false` or env
   * `WMUX_DISABLE_CDP=true`) closes the port; browser automation then fails
   * with an explicit error instead of silently. See docs/SECURITY.md §3.
   */
  browser?: BrowserCdpConfig;
  /**
   * #783 — PreToolUse permission gate control. OPTIONAL — old config.json files
   * predate it and must keep loading, so `validateConfig` deliberately ignores
   * this field and `loadConfig` backfills it per-field without resetting the
   * rest of the file (same convention as `browser`/`lanlink`).
   *
   * `gatedTools` is the set of Claude Code tool names that trigger a remote
   * permission gate when the agent runs inside a wmux pane. Defaults to the
   * high-risk tools only (Bash, Write, Edit, NotebookEdit) — gating every tool
   * would add constant latency on the Mac for little safety gain. The user
   * extends it with `wmux gate --add`. An empty array disables the gate
   * entirely (same as `WMUX_GATE=0`, but durable).
   */
  gate?: GateConfig;
  /**
   * Outbound notification sinks — a webhook or ntfy URL that gets a small
   * plaintext ping when an approval is raised or an agent turn ends. For people
   * running wmux without the phone app; the sealed APNs path is unaffected and
   * independent.
   *
   * OPTIONAL and OFF by default (absent = an empty list = no outbound traffic).
   * `validateConfig` deliberately ignores it and `loadConfig` backfills it
   * per-field, same convention as `browser`/`lanlink`/`gate`. A malformed entry
   * is dropped individually rather than resetting the file.
   *
   * The payload is a hard-allowlisted summary — event kind, static title, agent
   * name, short pane/workspace id prefixes, a derived risk tier and a timestamp.
   * It never carries the agent's question, tool input, terminal output, paths or
   * tokens. See `push/notifyPayload.ts`.
   */
  notifySinks?: NotifySinkConfig[];
  /**
   * Presence-based push suppression. OPTIONAL — old config.json files predate
   * it and must keep loading, so `validateConfig` deliberately ignores this
   * field and `loadConfig` backfills it per-field without resetting the rest of
   * the file (same convention as `gate`/`browser`/`lanlink`).
   *
   * When the desktop app is attached to the daemon AND its window was focused
   * within `staleAfterMs`, the phone push for an approval is skipped — the
   * event still reaches the in-app inbox the user is already looking at. Ships
   * ON, because the default failure mode is toward notifying: an unknown,
   * stale, or never-reported presence sends the push, and a `critical`-risk
   * approval sends it regardless. See `daemon/push/presence.ts`.
   */
  pushPresenceSuppression?: PushPresenceSuppressionConfig;
}

/**
 * Browser automation control slice (issue #613). `cdp.enabled` defaults true
 * for compatibility — disabling it closes Electron's remote-debugging port.
 */
export interface BrowserCdpConfig {
  cdp: {
    enabled?: boolean;
  };
}
