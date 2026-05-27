import { DaemonClient } from '../DaemonClient';
import type { DaemonInfo } from './launcher';

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
}

export type RespawnEvent =
  | { type: 'reconnecting'; attempt: number; backoffMs: number }
  | { type: 'reconnected' }
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
  /** Per-ping timeout. Default 3s. */
  healthTimeoutMs?: number;
  /** Consecutive ping failures that force a respawn. Default 3. */
  hangFailureThreshold?: number;
}

const DEFAULTS: Required<DaemonRespawnConfig> = {
  budget: 5,
  resetWindowMs: 5 * 60 * 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 30_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 3_000,
  hangFailureThreshold: 3,
};

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
    // accepts. Same gate the original bootstrap used.
    try {
      await client.rpc('daemon.ping', {});
    } catch (err) {
      this.deps.logger.warn(`daemon auth/ping failed: ${this.stringifyError(err)}`);
      await client.disconnect().catch(() => { /* best-effort */ });
      return null;
    }
    return client;
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
      await client.rpc('daemon.ping', {}, { timeoutMs: this.cfg.healthTimeoutMs });
      this.healthFailureCount = 0;
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
