// ─── Command Deck — global concurrent-turn gate ──────────────────────────────
//
// A tiny counting semaphore capping how many AUTONOMOUS brain turns may be in
// flight ACROSS all workspaces at once. Each workspace's CommanderSessionManager
// is already one-turn-at-a-time on its OWN thread, but with many workspaces a
// hook/detector storm (or a fleet of running loops) can wake several brains at
// the same instant — N parallel SDK subprocesses each burning tokens and CPU.
// This gate is the fleet-wide ceiling that chokes that at the single autonomous
// entrypoint (deck.handler's runTurnForWorkspace).
//
// Two acquire disciplines share the one gate:
//   - tryAcquire()            — fast, non-blocking. Over the cap it returns null
//                               and the caller (coalescer/scheduler) requeues.
//   - acquireWhenAvailable()  — awaits a slot (FIFO) up to a timeout. Used by the
//                               ONE-SHOT autonomous callers (loop kickoff,
//                               decision resume, startup reconcile) that would
//                               otherwise silently drop their turn on a transient
//                               full gate with no event to retry them.
//
// Slots are tracked BY TOKEN (not a bare counter) so a double-release or a
// stale-release (a wedged turn finishing long after its slot was reclaimed) is a
// safe no-op rather than a phantom decrement that widens the effective cap. Each
// slot also carries a LEASE: a slot held past LEASE_MS is treated as wedged
// (a hung claude.exe whose SDK stream never settled) and reclaimed, so two wedged
// turns can't deadlock every autonomous wake fleet-wide. The wedged turn may
// still be physically running when its slot is reclaimed — the cap can transiently
// exceed by that one turn, which is acceptable: unwedging the fleet wins.
//
// NOT module-global state: deck.handler owns exactly ONE instance (constructed
// per registration), so a test — or a second registration — starts from a clean
// count. Human DECK_SEND deliberately does NOT pass through here: a person's
// typed turn is never throttled by ambient autonomous load.

/** Default fleet-wide ceiling on concurrent autonomous turns. */
export const DEFAULT_GLOBAL_TURN_CAP = 2;

/** A slot held longer than this is treated as wedged and reclaimed. Generous
 *  beyond any sane turn (15 min) — the safety net for a hung subprocess whose
 *  stream never settles, never a throttle on legitimately long turns. */
export const DEFAULT_TURN_LEASE_MS = 15 * 60 * 1000;

/** Upper bound on queued waiters. A storm that would queue more than this many
 *  one-shot turns resolves the excess as `false` immediately (they reject `busy`
 *  and rely on their own retry path) rather than growing an unbounded queue. */
export const MAX_TURN_WAITERS = 32;

export interface GlobalTurnGateOptions {
  /** Override the wedged-slot lease (ms). Defaults to DEFAULT_TURN_LEASE_MS. */
  leaseMs?: number;
  /** Override the queued-waiter bound. Defaults to MAX_TURN_WAITERS. */
  maxWaiters?: number;
}

interface Slot {
  workspaceId: string;
  acquiredAt: number;
}

interface Waiter {
  workspaceId: string;
  resolve: (token: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GlobalTurnGate {
  private readonly cap: number;
  private readonly leaseMs: number;
  private readonly maxWaiters: number;
  /** Live slots keyed by the opaque token handed to the acquirer. release() and
   *  lease-reclaim both operate by token, so stale/duplicate releases are safe. */
  private readonly slots = new Map<string, Slot>();
  /** FIFO queue of turns awaiting a slot (acquireWhenAvailable). */
  private readonly waiters: Waiter[] = [];
  private seq = 0;
  private disposed = false;

  constructor(cap: number = DEFAULT_GLOBAL_TURN_CAP, opts: GlobalTurnGateOptions = {}) {
    this.cap = Math.max(1, Math.floor(cap));
    this.leaseMs =
      typeof opts.leaseMs === 'number' && opts.leaseMs > 0 ? opts.leaseMs : DEFAULT_TURN_LEASE_MS;
    this.maxWaiters =
      typeof opts.maxWaiters === 'number' && opts.maxWaiters > 0
        ? Math.floor(opts.maxWaiters)
        : MAX_TURN_WAITERS;
  }

  /** Reserve a slot without blocking. Returns an opaque token to pass to
   *  release(), or null when the cap is full — the caller treats null as a `busy`
   *  reject and retries later. `workspaceId` is recorded for the wedged-slot
   *  warning. Sweeps expired (wedged) slots first, so a fleet deadlocked on two
   *  hung turns self-heals once their lease elapses. */
  tryAcquire(workspaceId = 'unknown'): string | null {
    this.reclaimExpired();
    if (this.slots.size >= this.cap) return null;
    return this.mint(workspaceId);
  }

  /** Await a slot up to `timeoutMs`, resolving the token on acquire (immediately
   *  if one is free, else FIFO when a slot is released/reclaimed) or null on
   *  timeout. The excess over the waiter bound — and any call after dispose() —
   *  resolves null at once. Used ONLY by the one-shot autonomous callers. */
  acquireWhenAvailable(timeoutMs: number, workspaceId = 'unknown'): Promise<string | null> {
    if (this.disposed) return Promise.resolve(null);
    const token = this.tryAcquire(workspaceId);
    if (token) return Promise.resolve(token);
    if (this.waiters.length >= this.maxWaiters) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const waiter: Waiter = {
        workspaceId,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        }, Math.max(0, timeoutMs)),
      };
      // Never keep Electron alive for a queued waiter.
      (waiter.timer as { unref?: () => void }).unref?.();
      this.waiters.push(waiter);
    });
  }

  /** Release a slot by its token. A token that is unknown — already reclaimed by
   *  lease, or a double release — is a safe no-op (no phantom decrement). Hands
   *  the freed capacity to the next FIFO waiter. */
  release(token: string): void {
    const existed = this.slots.delete(token);
    if (!existed) return;
    this.pump();
  }

  /** Slots currently held (test/observability). */
  get inFlight(): number {
    return this.slots.size;
  }

  /** Clear all waiters (resolving them null) and slots. Called on handler
   *  teardown so no queued timer keeps the process alive. */
  dispose(): void {
    this.disposed = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters.length = 0;
    this.slots.clear();
  }

  /** Reclaim any slot held past its lease (a wedged turn whose stream never
   *  settled). Warns once per reclaimed slot, naming the workspace. */
  private reclaimExpired(): void {
    if (this.slots.size === 0) return;
    const now = Date.now();
    for (const [token, slot] of this.slots) {
      if (now - slot.acquiredAt >= this.leaseMs) {
        this.slots.delete(token);
        const heldS = Math.round((now - slot.acquiredAt) / 1000);
        // eslint-disable-next-line no-console
        console.warn(
          `[deck] GlobalTurnGate reclaimed a wedged turn slot held ${heldS}s by workspace ` +
            `${slot.workspaceId} (lease ${Math.round(this.leaseMs / 1000)}s) — its late release is a no-op`,
        );
      }
    }
  }

  /** Hand freed capacity to FIFO waiters until the cap is reached again. */
  private pump(): void {
    this.reclaimExpired();
    while (this.waiters.length > 0 && this.slots.size < this.cap) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(this.mint(w.workspaceId));
    }
  }

  private mint(workspaceId: string): string {
    const token = `turn-${++this.seq}`;
    this.slots.set(token, { workspaceId, acquiredAt: Date.now() });
    return token;
  }
}

/** Construct the one gate deck.handler owns. Factory (not a singleton) so each
 *  registration/test gets its own count. */
export function createGlobalTurnGate(
  cap: number = DEFAULT_GLOBAL_TURN_CAP,
  opts: GlobalTurnGateOptions = {},
): GlobalTurnGate {
  return new GlobalTurnGate(cap, opts);
}
