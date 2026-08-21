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
  notified: boolean;     // active→idle already fired — waiting for new cycle
  activeFired: boolean;  // onActive already fired this cycle — dedup IPC spam
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastReschedule: number; // last time we (re)scheduled the idle timer
}

export class ActivityMonitor {
  // Must output > 2000 bytes in 3 seconds to enter "active" state
  private static ACTIVE_THRESHOLD = 2000;
  private static ACTIVE_WINDOW_MS = 3000;

  // Must be idle for 5 seconds after active period
  private static IDLE_DELAY_MS = 5000;

  // Throttle reschedule of the idle timer in the active hot path. Worst-case
  // skew is bounded by IDLE_DELAY_MS + RESCHEDULE_THROTTLE_MS (≈5.1s).
  private static RESCHEDULE_THROTTLE_MS = 100;

  private states = new Map<string, PtyState>();
  private idleCallbacks: ((ptyId: string) => void)[] = [];
  private activeCallbacks: ((ptyId: string) => void)[] = [];

  /**
   * Fires once when a PTY drops to idle after a sustained burst. Returns an
   * unsubscribe function — call it on disposal to prevent listener leaks.
   */
  onActiveToIdle(callback: (ptyId: string) => void): () => void {
    this.idleCallbacks.push(callback);
    return () => {
      const idx = this.idleCallbacks.indexOf(callback);
      if (idx >= 0) this.idleCallbacks.splice(idx, 1);
    };
  }

  /**
   * Fires once per active cycle when a PTY's output crosses the throughput
   * threshold (the start of a sustained burst). PTYBridge wires this to set
   * `metadata.agentStatus = 'running'` and reset AgentDetector's emission
   * dedup state so the next idle prompt fires again on this PTY's next turn.
   *
   * Per-cycle dedup: only one fire per active cycle. A subsequent active
   * cycle (after onActiveToIdle has fired) is allowed to fire again.
   */
  onActive(callback: (ptyId: string) => void): () => void {
    this.activeCallbacks.push(callback);
    return () => {
      const idx = this.activeCallbacks.indexOf(callback);
      if (idx >= 0) this.activeCallbacks.splice(idx, 1);
    };
  }

  start(ptyId: string): void {
    this.states.set(ptyId, {
      bytes: 0,
      windowStart: Date.now(),
      active: false,
      notified: false,
      activeFired: false,
      idleTimer: null,
      lastReschedule: 0,
    });
  }

  /**
   * Re-arm a cycle from an explicit submitted-input boundary. Unlike passive
   * throughput detection, the next output byte is enough to prove this turn is
   * running: short agent replies must not remain stuck in the previous
   * waiting/complete state just because they never cross the 2 KB threshold.
   * No callback fires until output actually arrives.
   */
  beginTurn(ptyId: string): void {
    const s = this.states.get(ptyId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.bytes = 0;
    s.windowStart = Date.now();
    s.active = true;
    s.notified = false;
    s.activeFired = false;
    s.idleTimer = null;
    s.lastReschedule = 0;
  }

  /**
   * Re-arm a cycle from an authoritative TURN END, so the pane's next turn can
   * report `running` again.
   *
   * `onActive` fires once per cycle and the cycle is otherwise re-armed only
   * inside the idle timer, which needs IDLE_DELAY_MS of complete byte silence.
   * A TUI painting a live elapsed counter keeps rescheduling that timer, so the
   * cycle never re-arms and the `complete` written by the Stop hook survives
   * the whole next turn.
   *
   * Deliberately NOT `beginTurn`: that one is proof a turn is STARTING (the
   * user pressed Enter), so it lets the very first byte count. A turn end is
   * proof of the opposite and the pane may keep emitting idle chrome, so this
   * re-arms the THRESHOLD path instead — the next genuine burst proves the new
   * turn, a stray repaint does not. No callback fires here.
   */
  endTurn(ptyId: string): void {
    const s = this.states.get(ptyId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.bytes = 0;
    s.windowStart = Date.now();
    s.active = false;
    // `notified` false so feed()'s first gate (`!active && !notified`) is open
    // again. Leaving it true would route the next burst through the re-arm
    // branch, which is equivalent here but claims something this edge does not
    // mean: that an idle callback had already been delivered.
    s.notified = false;
    s.activeFired = false;
    s.idleTimer = null;
    s.lastReschedule = 0;
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

    // If active, reset the idle countdown — but throttle the reschedule
    // to avoid clearTimeout/setTimeout churn on every chunk under heavy
    // output. Skew on the active→idle detection is bounded by IDLE_DELAY_MS
    // + RESCHEDULE_THROTTLE_MS, which is acceptable for the 5s idle window.
    if (s.active) {
      // Fire onActive exactly once per cycle (re-armed when onActiveToIdle
      // fires below). This is the 'running' signal — IPC spam protection.
      if (!s.activeFired) {
        s.activeFired = true;
        this.activeCallbacks.forEach((cb) => cb(ptyId));
      }

      // `s.active` is re-read because a listener may have called endTurn() to
      // hand the cycle back (a burst it judged to be echo or a repaint). The
      // outer check ran before the callbacks; scheduling an idle timer for a
      // cycle that no longer exists would leave a dangling timer behind every
      // such rejection.
      if (
        s.active &&
        (!s.idleTimer ||
          now - s.lastReschedule >= ActivityMonitor.RESCHEDULE_THROTTLE_MS)
      ) {
        if (s.idleTimer) clearTimeout(s.idleTimer);
        s.lastReschedule = now;
        s.idleTimer = setTimeout(() => {
          if (!s.active) return;
          s.active = false;
          s.notified = true;     // prevent re-firing idle until new cycle
          s.activeFired = false; // re-arm onActive for the next cycle
          s.idleTimer = null;
          this.idleCallbacks.forEach((cb) => cb(ptyId));
        }, ActivityMonitor.IDLE_DELAY_MS);
      }
    }
  }

  stop(ptyId: string): void {
    const s = this.states.get(ptyId);
    if (s?.idleTimer) clearTimeout(s.idleTimer);
    this.states.delete(ptyId);
  }
}
