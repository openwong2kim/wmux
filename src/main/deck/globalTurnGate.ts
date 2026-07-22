// ─── Command Deck — global concurrent-turn gate ──────────────────────────────
//
// A tiny counting semaphore capping how many AUTONOMOUS brain turns may be in
// flight ACROSS all workspaces at once. Each workspace's CommanderSessionManager
// is already one-turn-at-a-time on its OWN thread, but with many workspaces a
// hook/detector storm (or a fleet of running loops) can wake several brains at
// the same instant — N parallel SDK subprocesses each burning tokens and CPU.
// This gate is the fleet-wide ceiling that chokes that at the single autonomous
// entrypoint (deck.handler's runTurnForWorkspace): over the cap a turn is
// rejected `busy` and its coalescer/scheduler retries later, exactly as a
// per-workspace busy reject already does.
//
// NOT module-global state: deck.handler owns exactly ONE instance (constructed
// per registration), so a test — or a second registration — starts from a clean
// count. Human DECK_SEND deliberately does NOT pass through here: a person's
// typed turn is never throttled by ambient autonomous load.

/** Default fleet-wide ceiling on concurrent autonomous turns. */
export const DEFAULT_GLOBAL_TURN_CAP = 2;

export class GlobalTurnGate {
  private readonly cap: number;
  private count = 0;
  /** Guards the below-zero warning so a buggy double-release logs once, not per
   *  call — the clamp keeps the count sane regardless. */
  private warnedUnderflow = false;

  constructor(cap: number = DEFAULT_GLOBAL_TURN_CAP) {
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** Reserve a slot. Returns false (and reserves nothing) when the cap is full —
   *  the caller must treat that as a `busy` reject and retry later. */
  tryAcquire(): boolean {
    if (this.count >= this.cap) return false;
    this.count += 1;
    return true;
  }

  /** Release a previously-acquired slot. Defensive: a release below zero clamps
   *  at zero and warns exactly once (a leaked/double release must never let the
   *  count go negative and silently widen the effective cap). */
  release(): void {
    if (this.count <= 0) {
      if (!this.warnedUnderflow) {
        this.warnedUnderflow = true;
        // eslint-disable-next-line no-console
        console.warn('[deck] GlobalTurnGate.release() called with no slot in flight — clamping at 0');
      }
      this.count = 0;
      return;
    }
    this.count -= 1;
  }

  /** Slots currently held (test/observability). */
  get inFlight(): number {
    return this.count;
  }
}

/** Construct the one gate deck.handler owns. Factory (not a singleton) so each
 *  registration/test gets its own count. */
export function createGlobalTurnGate(cap: number = DEFAULT_GLOBAL_TURN_CAP): GlobalTurnGate {
  return new GlobalTurnGate(cap);
}
