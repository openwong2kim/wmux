/**
 * Internal daemon health monitor with escalating memory pressure responses.
 * Periodically checks daemon health metrics and takes corrective action.
 * No Electron dependencies.
 */

export interface WatchdogCallbacks {
  /** Called when dead sessions should be reaped to free memory. */
  onReapDeadSessions?: () => number; // returns count of reaped sessions
  /** Called when new session creation should be blocked. */
  onBlockNewSessions?: (blocked: boolean) => void;
  /**
   * Read the current idle snapshot. Wired from the daemon main loop so
   * the Watchdog stays agnostic of `DaemonPipeServer` / `DaemonSessionManager`.
   *
   * - `connections`: live RPC clients (typically wmux main = 1)
   * - `sessions`: live PTY sessions managed by `DaemonSessionManager`
   * - `lastDisconnectAt`: ms timestamp of the most recent moment
   *   connections fell to zero, or `null` if a client has never
   *   connected during this daemon's lifetime
   */
  onIdleCheck?: () => { connections: number; sessions: number; lastDisconnectAt: number | null };
  /**
   * Fired when the watchdog determines the daemon has been idle long
   * enough to self-terminate. Daemon main loop hooks this to call its
   * `shutdown('idle.timeout', ...)` path. Receives the measured idle
   * window in ms for log breadcrumbs.
   */
  onIdleShutdown?: (idleMs: number) => void;
}

export class Watchdog {
  private intervalId: NodeJS.Timeout | null = null;
  private callbacks: WatchdogCallbacks = {};
  private sessionsBlocked = false;
  private checkCount = 0;
  private idleShutdownFired = false;

  // Memory escalation thresholds (bytes). Instance-level (was static) so the
  // daemon can thread config.daemon.mem{Warn,Reap,Block}Mb. The defaults
  // preserve the historical 500/750/1024 MB ladder for callers that omit
  // memConfig — which keeps every existing Watchdog escalation test locked
  // to the same behaviour (substrate 3.0 regression #2).
  private readonly warnBytes: number;
  private readonly reapBytes: number;
  private readonly blockBytes: number;

  /**
   * @param checkIntervalMs how often to poll health (default 30s)
   * @param idleConfig      idle-shutdown thresholds — set both to positive
   *                        values to enable, set `idleTimeoutMs <= 0` to
   *                        keep the daemon alive forever (default behavior
   *                        before this knob existed)
   * @param memConfig       memory-pressure escalation thresholds in MB. The
   *                        daemon passes config.daemon.mem{Warn,Reap,Block}Mb
   *                        (already clamped + ordered by loadConfig). Omit to
   *                        get the default 500/750/1024 MB ladder.
   */
  constructor(
    private readonly checkIntervalMs: number = 30000,
    private readonly idleConfig: { idleTimeoutMs: number; graceMs: number; startTime: number } = {
      idleTimeoutMs: 0, // disabled by default — explicit opt-in from daemon main
      graceMs: 60_000,
      startTime: Date.now(),
    },
    memConfig: { warnMb: number; reapMb: number; blockMb: number } = {
      warnMb: 500,
      reapMb: 750,
      blockMb: 1024,
    },
  ) {
    this.warnBytes = memConfig.warnMb * 1024 * 1024;
    this.reapBytes = memConfig.reapMb * 1024 * 1024;
    this.blockBytes = memConfig.blockMb * 1024 * 1024;
  }

  setCallbacks(callbacks: WatchdogCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Whether new session creation is currently blocked by memory pressure. */
  get isBlocked(): boolean {
    return this.sessionsBlocked;
  }

  /** Start periodic health checks. */
  start(healthCheck: () => { sessions: number; memory: number; uptime: number }): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      try {
        const health = healthCheck();
        const memMB = (health.memory / 1024 / 1024).toFixed(1);

        // Level 3: Block new sessions (>= block threshold)
        if (health.memory >= this.blockBytes) {
          if (!this.sessionsBlocked) {
            this.sessionsBlocked = true;
            this.callbacks.onBlockNewSessions?.(true);
            console.log(`[Watchdog] CRITICAL: Memory ${memMB}MB >= ${Math.round(this.blockBytes / 1024 / 1024)}MB — blocking new sessions`);
          }
        }

        // Level 2: Reap dead sessions (>= reap threshold)
        if (health.memory >= this.reapBytes) {
          const reaped = this.callbacks.onReapDeadSessions?.() ?? 0;
          if (reaped > 0) {
            console.log(`[Watchdog] WARNING: Memory ${memMB}MB >= ${Math.round(this.reapBytes / 1024 / 1024)}MB — reaped ${reaped} dead sessions`);
          }
        }

        // Level 1: Warning (>= warn threshold)
        if (health.memory >= this.warnBytes) {
          console.log(`[Watchdog] WARNING: Memory ${memMB}MB exceeds ${Math.round(this.warnBytes / 1024 / 1024)}MB threshold`);
        }

        // Recovery: unblock if memory drops below block threshold
        if (this.sessionsBlocked && health.memory < this.blockBytes) {
          this.sessionsBlocked = false;
          this.callbacks.onBlockNewSessions?.(false);
          console.log(`[Watchdog] Memory recovered to ${memMB}MB — unblocking new sessions`);
        }

        // Regular health log (only every 5th check to reduce noise)
        this.checkCount++;
        if (this.checkCount % 5 === 0) {
          console.log(
            `[Watchdog] Health: sessions=${health.sessions}, memory=${memMB}MB, uptime=${health.uptime}s`,
          );
        }

        this.evaluateIdle();
      } catch (err) {
        console.log(`[Watchdog] Health check failed:`, err);
      }
    }, this.checkIntervalMs);

    // Allow the timer to not block process exit
    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  /** Stop the watchdog. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Idle-shutdown evaluation. Pulled out so it can be exercised directly
   * by tests without driving the full 30s interval. The decision tree:
   *
   *   1. Disabled via `idleTimeoutMs <= 0` → never fire.
   *   2. Already fired once → never fire again (the daemon is on its
   *      way down; firing twice would spam `onIdleShutdown` calls).
   *   3. Still inside grace window → too early to even ask.
   *   4. Active connections OR live sessions → daemon is in use.
   *   5. Compute idle window from `lastDisconnectAt ?? startTime` —
   *      a daemon that booted and never saw a client counts grace +
   *      idleTimeout elapsed since boot.
   *   6. If `idleMs >= idleTimeoutMs` → fire.
   */
  evaluateIdle(): void {
    if (this.idleShutdownFired) return;
    const { idleTimeoutMs, graceMs, startTime } = this.idleConfig;
    if (idleTimeoutMs <= 0) return;

    const now = Date.now();
    if (now - startTime < graceMs) return;

    const info = this.callbacks.onIdleCheck?.();
    if (!info) return; // wiring missing — refuse to act
    if (info.connections > 0 || info.sessions > 0) return;

    const lastActivityAt = info.lastDisconnectAt ?? startTime;
    const idleMs = now - lastActivityAt;
    if (idleMs < idleTimeoutMs) return;

    this.idleShutdownFired = true;
    this.callbacks.onIdleShutdown?.(idleMs);
  }

  /** Reset the one-shot fired flag — exposed for tests. */
  resetIdleFiredFlagForTest(): void {
    this.idleShutdownFired = false;
  }
}
