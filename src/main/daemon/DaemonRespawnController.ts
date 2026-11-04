import { DaemonClient } from '../DaemonClient';
import type { DaemonInfo, DaemonPingResult } from './launcher';
import type { ProcessLiveness } from '../../shared/processLiveness';
import { isDaemonOlder, runDaemonReplacement, type ShutdownRpcResult } from './daemonReplacement';
import type { DaemonExitWatch } from './daemonExitWatch';
import {
  DAEMON_PROGRESS_DEFAULTS, DaemonProgressTracker, UNREADABLE_SAMPLE,
  type DaemonProcessSample, type DaemonProgress, type DaemonProgressConfig,
} from '../../shared/daemon/daemonProgress';
import { LaunchdJobQueuedError } from '../../shared/daemon/launchdDaemonJob';
import { DAEMON_READY_HARD_CEILING_MS, DaemonStartRefusedError } from '../../shared/daemon/daemonLauncherCore';

export interface DaemonRespawnState {
  attempt: number;
  backoffMs: number;
}

export interface DaemonRespawnDeps {
  /**
   * Spawn (or discover) the daemon and return its pipe + auth token.
   * Wraps `ensureDaemon()` from `./launcher`.
   */
  ensureDaemon: () => Promise<DaemonInfo>;
  /**
   * Build a fresh `DaemonClient` for the given pipe + token. Indirection
   * exists so unit tests can supply a fake client.
   */
  createClient: (pipeName: string, token: string) => DaemonClient;
  /**
   * Called once a respawned client has been successfully connected and
   * authenticated. Owns handler swap to daemon-routed IPC, mounting the
   * notification router, and broadcasting `daemon:connected` /
   * `daemon:reconnected` to the renderer.
   */
  onInstall: (client: DaemonClient) => Promise<void> | void;
  /**
   * Called when the active client has disconnected and respawn has started
   * (or after budget exhaustion). Owns handler swap back to local-PTY,
   * stopping the notification router, and broadcasting
   * `daemon:disconnected`.
   */
  onUninstall: () => void;
  /**
   * Renderer-facing event emitter. Reasons: `reconnecting`, `reconnected`,
   * `respawn-exhausted`.
   */
  emit: (event: RespawnEvent) => void;
  /**
   * #2263 — called once the health probe has subscribed the live client to
   * events again after the daemon dropped it, and only after the daemon
   * accepted that subscribe (a refused attempt is retried first). Everything pushed in between is
   * lost, so the owner reconciles pane state from a fresh read. Optional.
   */
  onEventsResubscribed?: (client: DaemonClient) => void;
  /** Structured log sink — info/warn/error. */
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /**
   * B′ stale-daemon auto-replacement hooks. Optional: when absent the
   * version gate never fires (existing tests / callers unaffected). All
   * effects are injected so the replacement flow is unit-testable.
   */
  replacement?: DaemonReplacementHooks;
  /**
   * Start watching the installed daemon's process so its exit code can be
   * logged when its socket closes (daemonExitWatch.ts). Optional: absent means
   * no exit line, as before.
   */
  watchDaemonExit?: (pid: number | null, spawned: boolean) => DaemonExitWatch;
  /**
   * Looks at the daemon's process when pings fail (daemonProgress.ts): a
   * daemon still using CPU is slow, not hung, and is not respawned. Optional:
   * absent means every hang is respawned, as before.
   */
  sampleDaemon?: (pid: number) => Promise<DaemonProcessSample>;
}

export interface DaemonReplacementHooks {
  appVersion: string;
  channelsEpoch: number;
  /** Wraps raceDaemonShutdown — carries the ack + the daemon's stateSaved additive. */
  raceShutdown: (client: DaemonClient, timeoutMs: number) => Promise<ShutdownRpcResult>;
  checkLiveness: (pid: number) => ProcessLiveness;
  /** Verified SIGKILL against an explicit pid (definitiveOnly mode). */
  killVerifiedPid: (pid: number) => boolean;
  /**
   * #545 — "is the daemon control pipe gone?" Second, tasklist-independent
   * proof that shutdown ran to completion. Optional: absent means the old
   * liveness-only behavior (existing tests / callers unaffected).
   */
  isPipeGone?: () => Promise<boolean>;
  /**
   * True when the user asked for "Shut down wmux completely". dispose()
   * fires on EVERY quit (before-quit calls it unconditionally, ahead of the
   * detach-vs-teardown branch), so a dispose observed mid-replacement must
   * only kill the freshly spawned daemon when the quit is a full shutdown —
   * a normal detach Quit wants a live daemon left behind (Codex delta
   * review). Absent means "never full shutdown" (kill suppressed).
   */
  isFullShutdown?: () => boolean;
  /** Test seam; production omits (real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export type RespawnEvent =
  | { type: 'reconnecting'; attempt: number; backoffMs: number }
  | { type: 'reconnected' }
  /** B′: a stale daemon was detected and a session-preserving replacement
   *  has started. Renderer shows an "updating daemon…" toast so the pane
   *  freeze + recovery replay reads as intentional, not a glitch. */
  | { type: 'replacing' }
  | {
      type: 'respawn-exhausted';
      /**
       * Last error message captured during the failed respawn loop, if
       * the controller has one. Undefined when the budget exhausted
       * without any captured throw (e.g. spawnAndConnect kept returning
       * null without raising). Main consumes this to populate the
       * Electron dialog so the user has something more actionable than
       * "wmux daemon could not start".
       */
      lastError?: string;
    };

export interface DaemonRespawnConfig {
  /** Max consecutive respawn attempts before giving up. Default 5. */
  budget?: number;
  /** Healthy-uptime threshold that resets the attempt counter. Default 5 min. */
  resetWindowMs?: number;
  /** Backoff schedule: min(base * 2^attempt, max). */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Health-probe interval. 0 disables the probe. Default 10s. */
  healthIntervalMs?: number;
  /** Per-ping timeout. Default 5s (RCA A4 — tolerate a busy daemon). */
  healthTimeoutMs?: number;
  /** Consecutive ping failures that force a respawn. Default 5 (RCA A4). */
  hangFailureThreshold?: number;
  /** How long a daemon that does not answer may go without CPU time before it is respawned (daemonProgress.ts). */
  progress?: DaemonProgressConfig;
  /**
   * How long an outage may wait on a daemon launchd has not started yet
   * without using up the budget. Default DAEMON_READY_HARD_CEILING_MS (90 s),
   * the time a spawned daemon gets to come up.
   */
  queuedWaitMs?: number;
}

const DEFAULTS: Required<DaemonRespawnConfig> = {
  budget: 5,
  resetWindowMs: 5 * 60 * 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 30_000,
  healthIntervalMs: 10_000,
  // RCA A4 — raised from 3s/3 so a daemon under CPU load (the ~9s event-loop
  // stall the RCA described) is not mistaken for a hang and force-respawned,
  // which would re-emit daemon:connected and re-trigger the reconcile path.
  healthTimeoutMs: 5_000,
  hangFailureThreshold: 5,
  progress: DAEMON_PROGRESS_DEFAULTS,
  queuedWaitMs: DAEMON_READY_HARD_CEILING_MS,
};

// RCA A4 — a successful ping reporting event-loop lag at/above this is logged
// as "busy but responsive" (never escalated; a daemon that answers is alive).
const BUSY_LAG_WARN_MS = 1_000;
/** Tries at reading the connected daemon's start time, and the wait between them. */
const BIND_ATTEMPTS = 3;
const BIND_RETRY_MS = 1_000;

/**
 * Owns the daemon-respawn lifecycle: detects disconnects, schedules
 * exponential-backoff respawns, drives an active health probe to catch
 * daemon-hang cases, resets attempt counters after sustained healthy
 * uptime, and routes lifecycle events to the renderer.
 *
 * The controller is intentionally agnostic about IPC handler wiring —
 * the caller supplies `onInstall(client)` and `onUninstall()` callbacks
 * so this module never has to know about `registerAllHandlers` /
 * `DaemonNotificationRouter` / `mainWindow`.
 *
 * Lifecycle:
 *   - `bootstrap()` performs the initial daemon launch + install. When it
 *     gets no client it enters the respawn budget loop, and the caller runs
 *     local ptys until a respawn installs one.
 *   - `dispose()` tears down timers + listeners. Safe to call from
 *     `before-quit`; it does NOT call `onUninstall()` because the caller
 *     usually wants a different (shutdown-race) teardown path.
 */
export class DaemonRespawnController {
  private readonly cfg: Required<DaemonRespawnConfig>;
  private client: DaemonClient | null = null;
  private disconnectedListener: (() => void) | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptCount = 0;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private healthFailureCount = 0;
  /** A health ping (and the look at the process after a failed one) is in flight. */
  private probing = false;
  private progress: DaemonProgressTracker;
  private uptimeResetTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private exhausted = false;
  /** True between the moment a disconnect was observed and the respawn
   *  loop has either succeeded or exhausted its budget. Used to suppress
   *  re-entrant respawn schedules from a health probe that races a real
   *  socket close. */
  private respawning = false;
  /** True while `bootstrap()` is launching the first daemon. */
  private bootstrapping = false;
  /**
   * Latest error captured by the respawn loop — set on bootstrap throw,
   * spawnAndConnect null returns inside attemptRespawn, and any other
   * caught error in the lifecycle. Surfaces in `respawn-exhausted` so
   * the renderer / main dialog can show a meaningful diagnostic instead
   * of a generic "wmux daemon could not start".
   */
  private lastError: string | undefined;
  /**
   * B′ once-per-run guard. Set BEFORE the replacement attempt (not on
   * success): re-arming on failure would let a persistently failing
   * replacement stall every reconnect by its full shutdown budget, and two
   * app instances of different versions could ping-pong a shared daemon.
   * Failure falls back to the C1 banner — today's behavior. Resets only
   * with the app process.
   */
  private replacedOnceThisRun = false;
  /**
   * When this outage first found the daemon still queued in launchd
   * (LaunchdJobQueuedError). Cleared by a successful install.
   */
  private queuedSince: number | null = null;
  /** The daemon behind the client spawnAndConnect last returned: its pid, and whether this process spawned it. */
  private connectedDaemon: { pid: number | null; spawned: boolean } = { pid: null, spawned: false };
  /** Watches the installed daemon's process for its exit code. */
  private exitWatch: DaemonExitWatch | null = null;

  constructor(
    private readonly deps: DaemonRespawnDeps,
    config: DaemonRespawnConfig = {},
  ) {
    this.cfg = { ...DEFAULTS, ...config };
    this.progress = new DaemonProgressTracker(this.cfg.progress);
  }

  /** True if a daemon client is currently installed and connected. */
  get isHealthy(): boolean {
    return this.client !== null && this.client.isConnected;
  }

  /**
   * #2398 — whether a daemon may still come (back) without an app restart:
   * the first launch is in flight, or a respawn is scheduled or running (a
   * failed first launch enters the respawn loop too). False once the
   * respawn budget ran out: the local-PTY fallback is then final, and a
   * session only the daemon held is gone for this run. Read while no client
   * is installed (the local handlers).
   */
  get daemonMayReturn(): boolean {
    if (this.disposed || this.exhausted) return false;
    return this.bootstrapping || this.respawning;
  }

  /**
   * The pid of the daemon behind the connected client, as recorded when the
   * connection was made: the pid its connect-time ping reported, else the
   * launcher's. Null while no client is connected, or when neither reported
   * one. Refreshed by every (re)connect. Readers that must not depend on the
   * daemon answering an RPC right now (the updater's install path) use this.
   */
  get connectedDaemonPid(): number | null {
    return this.client !== null && this.client.isConnected ? this.connectedDaemon.pid : null;
  }

  /** Current active client, or null when in local-only fallback. */
  getClient(): DaemonClient | null {
    return this.client;
  }

  /**
   * Perform the initial daemon launch + install. Should be called once
   * from `app.on('ready')`. On failure the respawn budget loop takes over
   * while the caller runs local ptys: a daemon can still come up after the
   * first launch gave up on it. After a reboot, launchd started a queued
   * daemon job ~45 s after its bootstrap, the launch had given up after 5 s,
   * and with no retry every daemon pane stayed blank until the app was
   * restarted.
   */
  async bootstrap(): Promise<DaemonClient | null> {
    if (this.disposed) throw new Error('DaemonRespawnController already disposed');
    if (this.client) return this.client;
    this.bootstrapping = true;
    try {
      const client = await this.spawnAndConnect();
      if (!client) {
        // spawnAndConnect already logged the specific reason. Capture
        // a generic anchor here so respawn-exhausted has something to
        // surface if the loop never makes it past the first attempt.
        this.lastError = this.lastError ?? 'daemon spawn/connect returned no client';
        this.deps.logger.warn(`bootstrap got no daemon client (${this.lastError}) — entering respawn budget loop`);
        this.handleDisconnect('bootstrap returned no client');
        return null;
      }
      await this.install(client, { isReconnect: false });
      return client;
    } catch (err) {
      this.lastError = this.stringifyError(err);
      if (err instanceof DaemonStartRefusedError) {
        // The user declined the recovery dialog: another start would only ask
        // again. Local mode stays final, as it always was here.
        this.deps.logger.warn(`bootstrap failed: ${this.lastError} — staying local`);
        return null;
      }
      this.deps.logger.warn(`bootstrap failed: ${this.lastError} — entering respawn budget loop`);
      if (err instanceof LaunchdJobQueuedError) this.queuedSince = Date.now();
      this.handleDisconnect('bootstrap failed');
      return null;
    } finally {
      this.bootstrapping = false;
    }
  }

  /**
   * Dispose timers + listeners. Does NOT trigger `onUninstall()` — the
   * `before-quit` path runs its own daemon-shutdown race and we don't
   * want to double-fire the handler swap.
   */
  dispose(): void {
    this.disposed = true;
    this.clearRespawnTimer();
    this.clearUptimeResetTimer();
    this.stopHealthProbe();
    this.detachDisconnectedListener();
    this.client = null;
    // Not a report: a detach Quit closes the socket with the daemon alive on purpose.
    this.exitWatch?.dispose();
    this.exitWatch = null;
  }

  /**
   * Hand the exit watch to the caller, so dispose() leaves it running. A full
   * shutdown keeps watching the daemon through its teardown: a native crash
   * there is one of the exits the watch exists for, and main is still alive
   * awaiting the shutdown RPC when it happens.
   */
  takeExitWatch(): DaemonExitWatch | null {
    const watch = this.exitWatch;
    this.exitWatch = null;
    return watch;
  }

  /** Public entry for tests / future manual reconnect UI. */
  async forceRespawn(): Promise<void> {
    if (this.disposed) return;
    // Treat as a synthetic disconnect so the same scheduling path runs.
    this.handleDisconnect('forceRespawn requested');
  }

  // --- internals ---

  private async spawnAndConnect(): Promise<DaemonClient | null> {
    const info = await this.deps.ensureDaemon();
    this.deps.logger.info(
      `daemon ${info.spawned ? 'spawned' : 'found'} (pid=${info.pid})`,
    );
    const client = this.deps.createClient(info.pipeName, info.authToken);
    const connected = await client.connect();
    if (!connected) {
      this.deps.logger.warn('control pipe connect failed after spawn');
      return null;
    }
    // Auth handshake — ensures the token we wrote is the one the daemon
    // accepts. Same gate the original bootstrap used. The pong doubles as
    // the B′ staleness signal (spawnedByVersion/channelsEpoch additives).
    let pong: DaemonPingResult | undefined;
    try {
      pong = (await client.rpc('daemon.ping', {})) as DaemonPingResult;
    } catch (err) {
      this.deps.logger.warn(`daemon auth/ping failed: ${this.stringifyError(err)}`);
      await client.disconnect().catch(() => { /* best-effort */ });
      return null;
    }
    const answered = this.answeringDaemon(info, pong);
    this.connectedDaemon = { pid: answered.pid, spawned: answered.spawned };
    this.bindDaemonIdentity(answered.pid);

    // B′ staleness gate. Only a REUSED daemon can be stale (a daemon we just
    // spawned runs this app's own binary), and only once per app run.
    const rep = this.deps.replacement;
    if (rep && !answered.spawned && !this.replacedOnceThisRun) {
      const verdict = isDaemonOlder(pong, rep.appVersion, rep.channelsEpoch);
      if (verdict.older) {
        return await this.replaceStaleDaemon(client, answered, rep, verdict.reason);
      }
      if (verdict.warnOnKeep) {
        // The C1 banner is epoch-driven and cannot fire for these keep
        // cases (newer daemon / sentinel / unparseable) — this log is the
        // only trace, deliberately (plan §4).
        this.deps.logger.warn(`daemon version gate: ${verdict.reason}`);
      }
    }
    return client;
  }

  /**
   * B′ replacement flow (plan §5). Steps 1–3 (shutdown → death confirm →
   * escalate/abort) live in runDaemonReplacement with injected effects;
   * this method owns the spawn of the fresh daemon and the before-quit
   * cancellation seams around it.
   */
  private async replaceStaleDaemon(
    oldClient: DaemonClient,
    oldInfo: DaemonInfo,
    rep: DaemonReplacementHooks,
    reason: string,
  ): Promise<DaemonClient | null> {
    if (oldInfo.pid === null) {
      // Only reachable via the #1001 yield-and-reconnect edge case (a spawn
      // that lost the race to an already-live daemon whose ping omitted
      // pid, with no daemon.pid to fall back to). Replacement needs a real
      // pid to verify-and-kill against; without one, surface the failure
      // through the normal budget/IPC path instead of guessing a pid.
      // The normal path's `disconnectClient` hook (wired into
      // runDaemonReplacement below) never runs for this early return, so it
      // must be done here explicitly — otherwise this connection to the
      // stale daemon leaks: never disconnected, and the caller (`ensure()`)
      // already has `null` back and no other handle to clean it up with.
      oldClient.disconnect();
      this.lastError = 'stale-daemon replacement skipped: old daemon info carries no verifiable pid';
      return null;
    }
    this.replacedOnceThisRun = true;
    this.deps.logger.warn(
      `stale daemon detected (${reason}) — starting session-preserving replacement of pid=${oldInfo.pid}`,
    );
    this.deps.emit({ type: 'replacing' });

    const sleep = rep.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const outcome = await runDaemonReplacement({
      oldPid: oldInfo.pid,
      shutdownRpc: (timeoutMs) => rep.raceShutdown(oldClient, timeoutMs),
      isClientConnected: () => oldClient.isConnected,
      disconnectClient: () => oldClient.disconnect(),
      checkLiveness: rep.checkLiveness,
      killVerifiedPid: rep.killVerifiedPid,
      // Absent hook → always "not gone", i.e. exactly the pre-#545 behavior.
      isPipeGone: rep.isPipeGone ?? (async () => false),
      sleep,
      isCancelled: () => this.disposed,
      log: (level, msg) => { this.deps.logger[level](msg); },
    });

    if (outcome === 'reuse-old-daemon') {
      // Pre-ack abort: nothing was suspended, the client is still live —
      // exactly today's behavior (C1 banner guides a manual restart).
      return oldClient;
    }
    if (outcome === 'cancelled') {
      // before-quit raced us after the old daemon died. Quit teardown owns
      // everything from here; sessions are durably suspended.
      return null;
    }
    if (outcome === 'dead-end') {
      this.lastError = `stale-daemon replacement dead-end (old pid=${oldInfo.pid})`;
      return null;
    }

    // 'old-daemon-dead' — spawn the fresh daemon through the normal path
    // (dead pid → stale-file cleanup → spawn, all existing launcher logic).
    let freshInfo: DaemonInfo;
    try {
      freshInfo = await this.deps.ensureDaemon();
    } catch (err) {
      this.lastError = `replacement spawn failed: ${this.stringifyError(err)}`;
      return null;
    }
    if (this.disposed) {
      // Quit raced the spawn itself. Two quit modes, opposite duties
      // (dispose() runs on BOTH — before-quit calls it ahead of the
      // detach-vs-teardown branch):
      //  - full shutdown: a detached fresh daemon surviving "shut down
      //    completely" violates the explicit teardown — kill what we just
      //    made (verified, explicit pid). Interrupted recovery is absorbed
      //    by the next boot's snapshot path.
      //  - normal detach Quit: the fresh daemon LIVING ON is the desired
      //    end state (it holds the recovered sessions; next launch reuses
      //    it) — killing it would break tmux-style persistence.
      if (freshInfo.spawned && (rep.isFullShutdown?.() ?? false)) {
        // freshInfo.pid is only ever null on the reconnect-to-existing
        // branch (spawned: false) — this is the spawned:true branch, so a
        // real pid is guaranteed, but the type is shared so guard anyway.
        if (freshInfo.pid !== null) rep.killVerifiedPid(freshInfo.pid);
      }
      return null;
    }
    const freshClient = this.deps.createClient(freshInfo.pipeName, freshInfo.authToken);
    const freshConnected = await freshClient.connect();
    if (!freshConnected) {
      this.lastError = 'replacement daemon spawned but control pipe connect failed';
      return null;
    }
    let freshPong: DaemonPingResult | undefined;
    try {
      freshPong = (await freshClient.rpc('daemon.ping', {})) as DaemonPingResult;
    } catch (err) {
      this.lastError = `replacement daemon auth/ping failed: ${this.stringifyError(err)}`;
      await freshClient.disconnect().catch(() => { /* best-effort */ });
      return null;
    }
    if (this.disposed) {
      // dispose() landed during connect()/ping (Codex code-review #1b).
      // Kill the fresh daemon ONLY for a full shutdown (see the disposed
      // check above — a normal detach Quit wants it alive). Any window
      // narrower than this (dispose after this check) is covered by
      // before-quit's pid-file kill, which runs AFTER dispose and the
      // fresh daemon has already written daemon.pid at acquireLock.
      await freshClient.disconnect().catch(() => { /* best-effort */ });
      if (freshInfo.spawned && (rep.isFullShutdown?.() ?? false)) {
        // freshInfo.pid is only ever null on the reconnect-to-existing
        // branch (spawned: false) — this is the spawned:true branch, so a
        // real pid is guaranteed, but the type is shared so guard anyway.
        if (freshInfo.pid !== null) rep.killVerifiedPid(freshInfo.pid);
      }
      return null;
    }
    this.deps.logger.info(
      `stale daemon replaced (old pid=${oldInfo.pid} → new pid=${freshInfo.pid})`,
    );
    const answered = this.answeringDaemon(freshInfo, freshPong);
    this.connectedDaemon = { pid: answered.pid, spawned: answered.spawned };
    this.bindDaemonIdentity(answered.pid);
    return freshClient;
  }

  /**
   * The daemon the client actually talks to. A reused daemon's pid comes from
   * the pid file, which can be stale or name a reused pid while the canonical
   * pipe still answers; the authenticated ping reports the pid of the daemon
   * that answered. That one is what the exit watch and a stale-daemon
   * replacement act on. When the two differ, the daemon is not the child just
   * spawned, so an ended child-exit record under its pid is never taken for
   * its exit. A daemon too old to report its pid leaves the launcher's answer.
   */
  private answeringDaemon(info: DaemonInfo, pong: DaemonPingResult | undefined): DaemonInfo {
    const pid = pong?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === info.pid) return info;
    if (info.pid === null) {
      this.deps.logger.info(`daemon pid ${pid} taken from its ping (the launcher had none)`);
    } else {
      this.deps.logger.warn(`daemon pid file names ${info.pid} but pid ${pid} answered the ping — using ${pid}`);
    }
    return { ...info, pid, spawned: false };
  }

  private async install(
    client: DaemonClient,
    opts: { isReconnect: boolean },
  ): Promise<void> {
    if (this.disposed) {
      await client.disconnect().catch(() => { /* best-effort */ });
      return;
    }
    this.client = client;
    // Clear `respawning` BEFORE wiring the disconnected listener for the
    // new client. Otherwise a disconnect from THIS client (e.g. the
    // freshly respawned daemon dying inside onInstall, or in the gap
    // between install resolving and attemptRespawn clearing the flag)
    // would hit `handleDisconnect`'s respawn-in-progress gate and be
    // coalesced away — leaving the controller with a dead client
    // installed, no onUninstall fired, and no respawn scheduled.
    // Codex review P2 (round 3) on issue #54.
    this.respawning = false;
    this.queuedSince = null;
    // Watch this daemon's process from now on: its exit code can only be read
    // through a handle opened while it is alive.
    this.exitWatch?.dispose();
    this.exitWatch = this.deps.watchDaemonExit?.(this.connectedDaemon.pid, this.connectedDaemon.spawned) ?? null;
    const exitWatch = this.exitWatch;
    // Wire the disconnected listener BEFORE we hand control to onInstall.
    // If a disconnect raced the install path itself, we still observe it.
    const listener = () => {
      this.deps.logger.warn('daemon disconnected (socket close)');
      void exitWatch?.report('socket close');
      this.handleDisconnect('socket close');
    };
    this.disconnectedListener = listener;
    client.on('disconnected', listener);

    await this.deps.onInstall(client);

    // onInstall could have raced a disconnect from this client (the
    // listener above would have run synchronously, called
    // handleDisconnect, nulled this.client, and scheduled a respawn).
    // In that case, swallow the rest of the install path so we don't
    // emit a misleading 'reconnected' or start a probe against a dead
    // socket on top of the new in-flight respawn.
    if (this.client !== client) return;

    // A successful install means the loop closed cleanly — any error
    // captured along the way is no longer the "latest" the user should
    // see if the budget exhausts later in this lifetime. Clear it.
    this.lastError = undefined;

    if (opts.isReconnect) {
      this.deps.emit({ type: 'reconnected' });
    }

    this.startHealthProbe();
    this.scheduleAttemptReset();
  }

  private scheduleAttemptReset(): void {
    this.clearUptimeResetTimer();
    if (this.attemptCount === 0) return;
    this.uptimeResetTimer = setTimeout(() => {
      if (this.disposed) return;
      this.deps.logger.info(
        `respawn attempt counter reset after ${this.cfg.resetWindowMs}ms healthy uptime`,
      );
      this.attemptCount = 0;
      this.exhausted = false;
    }, this.cfg.resetWindowMs);
  }

  private startHealthProbe(): void {
    this.stopHealthProbe();
    if (this.cfg.healthIntervalMs <= 0) return;
    this.healthFailureCount = 0;
    this.healthInterval = setInterval(() => {
      if (this.probing) return;
      this.probing = true;
      void this.runHealthPing().finally(() => { this.probing = false; });
    }, this.cfg.healthIntervalMs);
  }

  // Clients with a resubscribe in flight (see runHealthPing).
  private readonly resubscribing = new WeakSet<DaemonClient>();

  private stopHealthProbe(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    this.healthFailureCount = 0;
    this.progress.reset();
  }

  private async runHealthPing(): Promise<void> {
    const client = this.client;
    if (!client || !client.isConnected) return;
    // The daemon this ping goes to, whatever is connected once it fails.
    const pid = this.connectedDaemon.pid;
    try {
      const pong = (await client.rpc('daemon.ping', {}, { timeoutMs: this.cfg.healthTimeoutMs })) as
        | { eventLoopLagMs?: number; eventsSubscribed?: boolean }
        | undefined;
      this.healthFailureCount = 0;
      this.progress.reset();
      // The daemon dropped this connection's event subscription (it fell
      // behind past the backpressure cap) but kept the socket. Without this the
      // app stays deaf to agent status, titles and notifications until it is
      // restarted. An older daemon omits the field.
      if (pong?.eventsSubscribed === false && this.client === client && !this.resubscribing.has(client)) {
        this.deps.logger.warn('daemon dropped our event subscription — subscribing again');
        // The owner's state reads start only after the daemon ACCEPTED a
        // subscribe: it refuses one while the socket is still backed up
        // (#2469), and a read taken before the accepted retry would miss a
        // change made in between, which no event then carries. One resubscribe
        // at a time; a refused one is asked again by the next ping.
        this.resubscribing.add(client);
        void client.resubscribeEvents().then((subscribed) => {
          if (this.client !== client) return;
          if (subscribed) this.deps.onEventsResubscribed?.(client);
          else this.deps.logger.warn('daemon refused our event subscribe — the next health ping asks again');
        }, () => undefined).finally(() => {
          this.resubscribing.delete(client);
        });
      }
      // RCA A4 — a ping that SUCCEEDS proves the daemon is alive even if its
      // event loop is lagging under load. Never escalate on a successful ping;
      // just surface the busy state for observability.
      const lag = pong?.eventLoopLagMs;
      if (typeof lag === 'number' && lag >= BUSY_LAG_WARN_MS) {
        this.deps.logger.info(`daemon busy but responsive (event-loop lag ~${lag}ms) — not a hang`);
      }
    } catch (err) {
      this.healthFailureCount++;
      this.deps.logger.warn(
        `daemon health ping failed (${this.healthFailureCount}/${this.cfg.hangFailureThreshold}): ${this.stringifyError(err)}`,
      );
      // Looked at from the first failure on, so the verdict at the threshold has history behind it.
      const progress = await this.observeProgress(pid);
      if (this.client !== client) return;
      if (this.healthFailureCount >= this.cfg.hangFailureThreshold) {
        if (progress === 'progressing') {
          this.deps.logger.warn('daemon not answering but its CPU time is still rising — slow, not hung; not respawning it');
          return;
        }
        // A read that failed (likeliest when the system is short of memory) is no verdict: held within the same budget.
        if (progress === 'unknown') {
          this.deps.logger.warn('daemon not answering and its CPU time cannot be read right now — not respawning it until the budget runs out');
          return;
        }
        this.deps.logger.error(
          `daemon hang detected — forcing respawn${progress === 'stalled' ? ' (no CPU time for the whole budget)' : ''}`,
        );
        // Says whether the daemon was still alive when main let go of it.
        void this.exitWatch?.report('health probe hang');
        // Force a clean disconnect. The socket-close path will still fire
        // `disconnected`; we set `respawning` first so it short-circuits
        // to the scheduling logic rather than racing us.
        this.handleDisconnect('health probe hang');
        try {
          client.disconnectSync();
        } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Records the connected daemon's start time, so a later sample of a pid
   * handed on to another process reads as gone. A read that fails is tried
   * twice more: an identity taken from a sample after the daemon stopped
   * answering could already be another process's.
   */
  private bindDaemonIdentity(pid: number | null): void {
    const sample = this.deps.sampleDaemon;
    if (pid === null || !sample) return;
    void (async () => {
      for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise<void>((resolve) => { const t = setTimeout(resolve, BIND_RETRY_MS); t.unref?.(); });
        if (this.disposed || this.connectedDaemon.pid !== pid) return;
        const s = await sample(pid).catch(() => null);
        if (this.connectedDaemon.pid !== pid) return;
        if (s && !s.alive) return;
        if (s?.startedAt) { this.progress.bind(pid, s.startedAt); return; }
      }
    })();
  }

  /** The tracker's verdict, or null when this host cannot sample a daemon at all (the respawn goes ahead as before). */
  private async observeProgress(pid: number | null): Promise<DaemonProgress | null> {
    const sample = this.deps.sampleDaemon;
    if (pid === null || !sample) return null;
    return this.progress.observe(pid, await sample(pid).catch(() => UNREADABLE_SAMPLE), Date.now());
  }

  private handleDisconnect(reason: string): void {
    if (this.disposed) return;
    if (this.respawning) {
      // Already in the loop — don't double-schedule.
      this.deps.logger.info(`disconnect during respawn (${reason}) — coalesced`);
      return;
    }
    this.respawning = true;
    this.stopHealthProbe();
    this.clearUptimeResetTimer();
    this.detachDisconnectedListener();
    this.client = null;

    // Tear down daemon-mode handlers so the user keeps typing in local-PTY
    // mode while we backoff. onUninstall is idempotent on the caller side.
    try {
      this.deps.onUninstall();
    } catch (err) {
      this.deps.logger.warn(`onUninstall threw: ${this.stringifyError(err)}`);
    }

    if (this.exhausted) {
      this.deps.logger.warn('respawn budget already exhausted — staying local');
      return;
    }
    this.scheduleRespawn();
  }

  private scheduleRespawn(): void {
    if (this.disposed) return;
    this.clearRespawnTimer();

    if (this.attemptCount >= this.cfg.budget) {
      this.exhausted = true;
      this.respawning = false;
      this.deps.logger.error(
        `respawn budget exhausted (${this.cfg.budget} attempts) — staying in local mode${this.lastError ? `; lastError=${this.lastError}` : ''}`,
      );
      this.deps.emit({ type: 'respawn-exhausted', lastError: this.lastError });
      return;
    }

    const attempt = this.attemptCount + 1; // 1-indexed for user-facing log
    const backoffMs = Math.min(
      this.cfg.baseBackoffMs * 2 ** this.attemptCount,
      this.cfg.maxBackoffMs,
    );
    this.attemptCount++;
    this.deps.logger.info(
      `scheduling daemon respawn attempt ${attempt}/${this.cfg.budget} in ${backoffMs}ms`,
    );
    this.deps.emit({ type: 'reconnecting', attempt, backoffMs });

    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      void this.attemptRespawn(attempt);
    }, backoffMs);
  }

  private async attemptRespawn(attempt: number): Promise<void> {
    if (this.disposed) return;
    try {
      const client = await this.spawnAndConnect();
      if (!client) {
        // spawnAndConnect logs detail; preserve it via lastError so
        // an exhausted budget has something to surface to the user.
        this.lastError = this.lastError ?? 'spawnAndConnect returned null';
        throw new Error('spawnAndConnect returned null');
      }
      await this.install(client, { isReconnect: true });
      // `respawning` is cleared inside install() now (before the
      // listener wires) so a disconnect from the new client during
      // onInstall is treated as a real event. If install() observed
      // such a disconnect and scheduled another respawn cycle, we
      // log success only when the new client is still installed.
      if (this.client === client) {
        this.deps.logger.info(`daemon respawn succeeded on attempt ${attempt}`);
      } else {
        this.deps.logger.warn(
          `respawn attempt ${attempt} client died during install — new respawn already scheduled`,
        );
      }
    } catch (err) {
      this.lastError = this.stringifyError(err);
      this.deps.logger.warn(
        `respawn attempt ${attempt} failed: ${this.lastError}`,
      );
      if (this.isQueuedWait(err)) {
        // launchd has the job and will start it; the next start waits on
        // that same job. Not a failed start, so it costs no budget.
        this.attemptCount--;
        this.deps.logger.info('daemon still queued in launchd — attempt not counted against the respawn budget');
      }
      // Loop back through the scheduler so backoff + budget tracking
      // applies uniformly. `respawning` is already true at this point
      // (set in handleDisconnect) so an in-flight listener event
      // from the failed-to-build client still coalesces — install()
      // would have cleared it only on a successful path.
      this.scheduleRespawn();
    }
  }

  /**
   * Whether a failed start only found the daemon still queued in launchd.
   * True until this outage has waited `queuedWaitMs` on a queued job, so a
   * launchd slowed down by a reboot cannot use up the budget while its daemon
   * is on the way. After that the budget counts as for any failed start.
   */
  private isQueuedWait(err: unknown): boolean {
    if (!(err instanceof LaunchdJobQueuedError)) return false;
    const now = Date.now();
    this.queuedSince ??= now;
    return now - this.queuedSince < this.cfg.queuedWaitMs;
  }

  private clearRespawnTimer(): void {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
  }

  private clearUptimeResetTimer(): void {
    if (this.uptimeResetTimer) {
      clearTimeout(this.uptimeResetTimer);
      this.uptimeResetTimer = null;
    }
  }

  private detachDisconnectedListener(): void {
    if (this.client && this.disconnectedListener) {
      try {
        this.client.off('disconnected', this.disconnectedListener);
      } catch { /* listener removal is best-effort */ }
    }
    this.disconnectedListener = null;
  }

  private stringifyError(err: unknown): string {
    if (err instanceof Error) return err.message;
    try { return String(err); } catch { return '<unstringifiable>'; }
  }
}
