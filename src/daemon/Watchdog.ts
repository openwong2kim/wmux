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
}

export class Watchdog {
  private intervalId: NodeJS.Timeout | null = null;
  private callbacks: WatchdogCallbacks = {};
  private sessionsBlocked = false;
  private checkCount = 0;

  // Escalation thresholds
  private static readonly WARN_BYTES = 500 * 1024 * 1024;   // 500 MB — log warning
  private static readonly REAP_BYTES = 750 * 1024 * 1024;   // 750 MB — reap dead sessions
  private static readonly BLOCK_BYTES = 1024 * 1024 * 1024; // 1 GB — block new sessions

  constructor(private readonly checkIntervalMs: number = 30000) {}

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

        // Level 3: Block new sessions (>= 1GB)
        if (health.memory >= Watchdog.BLOCK_BYTES) {
          if (!this.sessionsBlocked) {
            this.sessionsBlocked = true;
            this.callbacks.onBlockNewSessions?.(true);
            console.log(`[Watchdog] CRITICAL: Memory ${memMB}MB >= 1GB — blocking new sessions`);
          }
        }

        // Level 2: Reap dead sessions (>= 750MB)
        if (health.memory >= Watchdog.REAP_BYTES) {
          const reaped = this.callbacks.onReapDeadSessions?.() ?? 0;
          if (reaped > 0) {
            console.log(`[Watchdog] WARNING: Memory ${memMB}MB >= 750MB — reaped ${reaped} dead sessions`);
          }
        }

        // Level 1: Warning (>= 500MB)
        if (health.memory >= Watchdog.WARN_BYTES) {
          console.log(`[Watchdog] WARNING: Memory ${memMB}MB exceeds 500MB threshold`);
        }

        // Recovery: unblock if memory drops below block threshold
        if (this.sessionsBlocked && health.memory < Watchdog.BLOCK_BYTES) {
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
}
