/**
 * Detects active→idle transitions in PTY output.
 *
 * Instead of fragile pattern matching, this monitors data throughput:
 *   - "active": sustained output > ACTIVE_THRESHOLD bytes over ACTIVE_WINDOW ms
 *   - "idle":   output drops below IDLE_THRESHOLD bytes for IDLE_DELAY ms
 *   - Notification fires on active→idle transition only
 *
 * This reliably catches "agent finished" for ANY agent without pattern matching.
 * User typing (short bursts) doesn't trigger because it never reaches sustained active state.
 */

interface PtyState {
  bytes: number;         // bytes accumulated in current window
  windowStart: number;   // start of current measurement window
  active: boolean;       // currently in "active" state?
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class ActivityMonitor {
  // Must output > 500 bytes in 3 seconds to enter "active" state
  private static ACTIVE_THRESHOLD = 500;
  private static ACTIVE_WINDOW_MS = 3000;

  // Must be idle (< 50 bytes) for 5 seconds to transition to "idle"
  private static IDLE_THRESHOLD = 50;
  private static IDLE_DELAY_MS = 5000;

  private states = new Map<string, PtyState>();
  private callbacks: ((ptyId: string) => void)[] = [];

  onActiveToIdle(callback: (ptyId: string) => void): void {
    this.callbacks.push(callback);
  }

  start(ptyId: string): void {
    this.states.set(ptyId, {
      bytes: 0,
      windowStart: Date.now(),
      active: false,
      idleTimer: null,
    });
  }

  /** Call on every onData event with the data length */
  feed(ptyId: string, byteCount: number): void {
    const s = this.states.get(ptyId);
    if (!s) return;

    const now = Date.now();

    // Reset window if expired
    if (now - s.windowStart > ActivityMonitor.ACTIVE_WINDOW_MS) {
      s.bytes = 0;
      s.windowStart = now;
    }

    s.bytes += byteCount;

    // Check if we should enter active state
    if (!s.active && s.bytes > ActivityMonitor.ACTIVE_THRESHOLD) {
      s.active = true;
      // Clear any pending idle timer
      if (s.idleTimer) {
        clearTimeout(s.idleTimer);
        s.idleTimer = null;
      }
    }

    // If active, reset the idle countdown on every data event
    if (s.active) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => {
        if (!s.active) return;
        s.active = false;
        s.idleTimer = null;
        this.callbacks.forEach((cb) => cb(ptyId));
      }, ActivityMonitor.IDLE_DELAY_MS);
    }
  }

  stop(ptyId: string): void {
    const s = this.states.get(ptyId);
    if (s?.idleTimer) clearTimeout(s.idleTimer);
    this.states.delete(ptyId);
  }
}
