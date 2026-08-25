import { DaemonClient } from '../DaemonClient';
import type { DaemonInfo, DaemonPingResult } from './launcher';
import type { ProcessLiveness } from '../../shared/processLiveness';
import { isDaemonOlder, runDaemonReplacement, type ShutdownRpcResult } from './daemonReplacement';

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
};

// RCA A4 — a successful ping reporting event-loop lag at/above this is logged
// as "busy but responsive" (never escalated; a daemon that answers is alive).
const BUSY_LAG_WARN_MS = 1_000;

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
 *   - `bootstrap()` performs the initial daemon launch + install. Throws
 *     on a hard failure so the caller can fall back to local-only mode.
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
  private uptimeResetTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private exhausted = false;
  /** True between the moment a disconnect was observed and the respawn
   *  loop has either succeeded or exhausted its budget. Used to suppress
   *  re-entrant respawn schedules from a health probe that races a real
   *  socket close. */
  private respawning = false;
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
   * B′: set when a replacement passed the point of no return (old daemon
   * dead / dying) but produced no new client. bootstrap() consumes this to
   * route into the respawn budget loop — without it, bootstrap's
   * single-shot failure path would strand the app in local mode with every
   * session suspended on disk (Codex #4 + Claude #2).
   */
  private replacementDeadEnd = false;

  constructor(
    private readonly deps: DaemonRespawnDeps,
    config: DaemonRespawnConfig = {},
  ) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  /** True if a daemon client is currently installed and connected. */
  get isHealthy(): boolean {
    return this.client !== null && this.client.isConnected;
  }

  /** Current active client, or null when in local-only fallback. */
  getClient(): DaemonClient | null {
    return this.client;
  }

  /**
   * Perform the initial daemon launch + install. Should be called once
   * from `app.on('ready')`. On failure the caller stays in local mode;
   * subsequent recovery is the user's responsibility (manual restart).
   */
  async bootstrap(): Promise<DaemonClient | null> {
    if (this.disposed) throw new Error('DaemonRespawnController already disposed');
    if (this.client) return this.client;
    try {
      const client = await this.spawnAndConnect();
      if (!client) {
        // B′: a replacement that killed the old daemon but failed to bring
        // up a new one must NOT strand the app in local mode — bootstrap
        // has no retry of its own, so hand off to the budgeted respawn
        // loop explicitly. Sessions are already durably suspended on disk.
        if (this.replacementDeadEnd && !this.disposed) {
          this.replacementDeadEnd = false;
          this.deps.logger.warn('replacement dead-end during bootstrap — entering respawn budget loop');
          this.handleDisconnect('replacement dead-end');
          return null;
        }
        // spawnAndConnect already logged the specific reason. Capture
        // a generic anchor here so respawn-exhausted has something to
        // surface if the loop never makes it past the first attempt.
        this.lastError = this.lastError ?? 'daemon spawn/connect returned no client';
        return null;
      }
      await this.install(client, { isReconnect: false });
      return client;
    } catch (err) {
      this.lastError = this.stringifyError(err);
      this.deps.logger.warn(`bootstrap failed: ${this.lastError}`);
      return null;
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

    // B′ staleness gate. Only a REUSED daemon can be stale (a daemon we just
    // spawned runs this app's own binary), and only once per app run.
    const rep = this.deps.replacement;
    if (rep && !info.spawned && !this.replacedOnceThisRun) {
      const verdict = isDaemonOlder(pong, rep.appVersion, rep.channelsEpoch);
      if (verdict.older) {
        return await this.replaceStaleDaemon(client, info, rep, verdict.reason);
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
      this.replacementDeadEnd = true;
      this.lastError = `stale-daemon replacement dead-end (old pid=${oldInfo.pid})`;
      return null;
    }

    // 'old-daemon-dead' — spawn the fresh daemon through the normal path
    // (dead pid → stale-file cleanup → spawn, all existing launcher logic).
    let freshInfo: DaemonInfo;
    try {
      freshInfo = await this.deps.ensureDaemon();
    } catch (err) {
      this.replacementDeadEnd = true;
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
      this.replacementDeadEnd = true;
      this.lastError = 'replacement daemon spawned but control pipe connect failed';
      return null;
    }
    try {
      await freshClient.rpc('daemon.ping', {});
    } catch (err) {
      this.replacementDeadEnd = true;
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
    return freshClient;
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
    // Wire the disconnected listener BEFORE we hand control to onInstall.
    // If a disconnect raced the install path itself, we still observe it.
    const listener = () => {
      this.deps.logger.warn('daemon disconnected (socket close)');
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
      void this.runHealthPing();
    }, this.cfg.healthIntervalMs);
  }

  private stopHealthProbe(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    this.healthFailureCount = 0;
  }

  private async runHealthPing(): Promise<void> {
    const client = this.client;
    if (!client || !client.isConnected) return;
    try {
      const pong = (await client.rpc('daemon.ping', {}, { timeoutMs: this.cfg.healthTimeoutMs })) as
        | { eventLoopLagMs?: number }
        | undefined;
      this.healthFailureCount = 0;
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
      if (this.healthFailureCount >= this.cfg.hangFailureThreshold) {
        this.deps.logger.error(
          'daemon hang detected — forcing respawn',
        );
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
      // Loop back through the scheduler so backoff + budget tracking
      // applies uniformly. `respawning` is already true at this point
      // (set in handleDisconnect) so an in-flight listener event
      // from the failed-to-build client still coalesces — install()
      // would have cleared it only on a successful path.
      this.scheduleRespawn();
    }
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
