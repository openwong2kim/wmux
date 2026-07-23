/**
 * Circuit breaker for A2A (agent-to-agent) message channels.
 * Prevents infinite message loops between agents by tracking per-channel
 * message rates in a sliding window and applying exponential backoff on trip.
 * No Electron dependencies — portable main-process utility.
 */

/** Snapshot of a single channel's circuit breaker state. */
export interface ChannelState {
  sendCount: number;
  windowStart: number;
  tripped: boolean;
  tripCount: number;
  blockedUntil: number; // timestamp, 0 if not blocked
}

/** Internal mutable state for each tracked channel. */
interface ChannelEntry {
  sendCount: number;
  windowStart: number;
  tripped: boolean;
  tripCount: number;
  blockedUntil: number;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sliding window duration in milliseconds. */
const WINDOW_MS = 60_000;

/** Maximum messages per window for normal (unicast) channels. */
const NORMAL_LIMIT = 15;

/** Maximum messages per window for broadcast channels. */
const BROADCAST_LIMIT = 30;

/** Maximum messages per window for self-echo channels (from === to). */
const SELF_ECHO_LIMIT = 3;

/** Exponential backoff durations in milliseconds. */
const BACKOFF_STEPS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

/** Channels with no activity for this long are eligible for pruning. */
const STALE_CHANNEL_MS = 5 * 60_000;

export class CircuitBreaker {
  private readonly channels = new Map<string, ChannelEntry>();
  private cleanupId: NodeJS.Timeout | null = null;

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Check whether a unicast message from `senderId` to `targetId` is allowed.
   * Returns `true` if the message may proceed, `false` if blocked.
   */
  checkSend(senderId: string, targetId: string, now: number = Date.now()): boolean {
    const key = `${senderId}:${targetId}`;
    const limit = senderId === targetId ? SELF_ECHO_LIMIT : NORMAL_LIMIT;
    return this.check(key, limit, now);
  }

  /**
   * Check whether a broadcast from `senderId` is allowed.
   * Broadcast tracking uses a dedicated channel key so it does not
   * interfere with individual unicast counters.
   */
  checkBroadcast(senderId: string, now: number = Date.now()): boolean {
    const key = `${senderId}:*broadcast*`;
    return this.check(key, BROADCAST_LIMIT, now);
  }

  /** Return the current state snapshot for a channel (for debugging / UI). */
  getChannelState(senderId: string, targetId: string): ChannelState | undefined {
    const entry = this.channels.get(`${senderId}:${targetId}`);
    if (!entry) return undefined;
    return {
      sendCount: entry.sendCount,
      windowStart: entry.windowStart,
      tripped: entry.tripped,
      tripCount: entry.tripCount,
      blockedUntil: entry.blockedUntil,
    };
  }

  /** Reset all internal state. Useful for testing or daemon restart. */
  reset(): void {
    this.channels.clear();
  }

  // -------------------------------------------------------------------
  // Cleanup lifecycle
  // -------------------------------------------------------------------

  /** Start periodic pruning of stale channels. */
  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupId) return;

    this.cleanupId = setInterval(() => {
      try {
        this.pruneStale(Date.now());
      } catch (err) {
        console.log(`[CircuitBreaker] Cleanup failed:`, err);
      }
    }, intervalMs);

    // Allow the timer to not block process exit
    if (this.cleanupId.unref) {
      this.cleanupId.unref();
    }
  }

  /** Stop periodic cleanup. */
  stopCleanup(): void {
    if (this.cleanupId) {
      clearInterval(this.cleanupId);
      this.cleanupId = null;
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Core rate-check logic shared by unicast and broadcast paths.
   * Creates a channel entry on first access, resets the sliding window
   * when it expires, and trips the breaker when the limit is exceeded.
   */
  private check(key: string, limit: number, now: number): boolean {
    let entry = this.channels.get(key);

    if (!entry) {
      entry = {
        sendCount: 0,
        windowStart: now,
        tripped: false,
        tripCount: 0,
        blockedUntil: 0,
        lastActivity: now,
      };
      this.channels.set(key, entry);
    }

    entry.lastActivity = now;

    // If currently blocked, check whether backoff has expired
    if (entry.blockedUntil > 0) {
      if (now < entry.blockedUntil) {
        return false;
      }
      // Backoff expired — recover
      this.recover(entry, now);
    }

    // Reset sliding window if it has elapsed
    if (now - entry.windowStart >= WINDOW_MS) {
      entry.sendCount = 0;
      entry.windowStart = now;
    }

    entry.sendCount++;

    // Trip the breaker when limit is exceeded
    if (entry.sendCount > limit) {
      this.trip(entry, now);
      return false;
    }

    return true;
  }

  /** Trip the breaker: mark it tripped and apply exponential backoff. */
  private trip(entry: ChannelEntry, now: number): void {
    entry.tripped = true;
    const stepIndex = Math.min(entry.tripCount, BACKOFF_STEPS_MS.length - 1);
    const backoffMs = BACKOFF_STEPS_MS[stepIndex];
    entry.blockedUntil = now + backoffMs;
    entry.tripCount++;
    console.log(
      `[CircuitBreaker] Channel tripped (trip #${entry.tripCount}), blocked for ${backoffMs / 1000}s`,
    );
  }

  /**
   * Recover a channel after its backoff expires.
   * If no new trips occurred during the recovery window (equal to the
   * last backoff duration), the trip count is reset so subsequent trips
   * start from the shortest backoff again.
   */
  private recover(entry: ChannelEntry, now: number): void {
    const lastBackoffIndex = Math.min(entry.tripCount - 1, BACKOFF_STEPS_MS.length - 1);
    const recoveryWindowMs = BACKOFF_STEPS_MS[Math.max(0, lastBackoffIndex)];

    // If enough quiet time has passed since the block ended, fully reset
    if (now - entry.blockedUntil >= recoveryWindowMs) {
      entry.tripCount = 0;
    }

    entry.tripped = false;
    entry.blockedUntil = 0;
    entry.sendCount = 0;
    entry.windowStart = now;
  }

  /** Remove channels that have had no activity in the last `STALE_CHANNEL_MS`. */
  private pruneStale(now: number): void {
    let pruned = 0;
    for (const [key, entry] of this.channels) {
      if (now - entry.lastActivity >= STALE_CHANNEL_MS) {
        this.channels.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[CircuitBreaker] Pruned ${pruned} stale channel(s)`);
    }
  }
}
