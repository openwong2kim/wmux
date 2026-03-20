/**
 * Detects active→idle transitions in PTY output.
 *
 * Instead of fragile pattern matching, this monitors data throughput:
 *   - "active": sustained output > ACTIVE_THRESHOLD bytes over ACTIVE_WINDOW ms
 *   - "idle":   no output for IDLE_DELAY ms after active period
 *   - Notification fires ONCE on active→idle, then waits for a new active cycle
 *
 * After firing, the monitor enters a "notified" state.
 * It will NOT fire again until the PTY produces another sustained burst
 * (a full new active cycle). This prevents notification spam from
 * small outputs like cursor blinks or prompt redraws.
 */

interface PtyState {
  bytes: number;
  windowStart: number;
  active: boolean;
  notified: boolean;     // already fired — waiting for new active cycle
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class ActivityMonitor {
  // Must output > 2000 bytes in 3 seconds to enter "active" state
  private static ACTIVE_THRESHOLD = 2000;
  private static ACTIVE_WINDOW_MS = 3000;

  // Must be idle for 5 seconds after active period
  private static IDLE_DELAY_MS = 5000;

  private states = new Map<string, PtyState>();
  private callbacks: ((ptyId: string) => void)[] = [];

  onActiveToIdle(callback: (ptyId: string) => void): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  start(ptyId: string): void {
    this.states.set(ptyId, {
      bytes: 0,
      windowStart: Date.now(),
      active: false,
      notified: false,
      idleTimer: null,
    });
  }

  feed(ptyId: string, byteCount: number): void {
    const s = this.states.get(ptyId);
    if (!s) return;

    const now = Date.now();

    // Reset measurement window if expired
    if (now - s.windowStart > ActivityMonitor.ACTIVE_WINDOW_MS) {
      s.bytes = 0;
      s.windowStart = now;
    }

    s.bytes += byteCount;

    // Enter active state when threshold reached (and not already notified)
    if (!s.active && !s.notified && s.bytes > ActivityMonitor.ACTIVE_THRESHOLD) {
      s.active = true;
    }

    // If already notified, check if this is a new significant burst to re-arm
    if (s.notified && s.bytes > ActivityMonitor.ACTIVE_THRESHOLD) {
      s.notified = false;
      s.active = true;
    }

    // If active, reset the idle countdown
    if (s.active) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => {
        if (!s.active) return;
        s.active = false;
        s.notified = true;  // prevent re-firing until new active cycle
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
