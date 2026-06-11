// Global LRU budget for xterm WebGL contexts.
//
// RCA (2026-05-30 blank-terminal-on-restore): Chromium hard-caps the number
// of simultaneous WebGL contexts per renderer process (~16; the exact number
// is driver/build dependent). xterm's WebglAddon creates one context per
// terminal. The renderer previously loaded a context for EVERY visible
// terminal with no global ceiling, so when tmux-style persistence restored a
// large session set (a user dogfood hit 20 live sessions) the visible-pane
// count sailed past Chromium's cap. Chromium then silently evicted the OLDEST
// context — "Too many active WebGL contexts. Oldest context will be lost." —
// and the affected terminals lost their renderer and went BLANK. The 10s
// deferred-dispose (WEBGL_HIDDEN_DISPOSE_DELAY_MS) amplified it by holding
// hidden terminals' contexts through view-switch churn.
//
// This pool makes the count deterministic: it hard-bounds live contexts BELOW
// Chromium's cap and grants them most-recently-requested first. Terminals over
// budget are disposed in a CONTROLLED way (the addon's documented teardown →
// xterm falls back to its DOM renderer, which always works), instead of being
// force-evicted by Chromium (uncontrolled, unreliable fallback, blank panes).
//
// Net effect: we never exceed the cap, so Chromium never force-evicts, so no
// terminal ever loses its renderer. The 12 most-recently-shown terminals get
// GPU acceleration; any extras render via DOM (visually identical, only slower
// on high-throughput output — invisible for the background panes you are not
// actively reading). Persistence can now restore an arbitrary session count
// and every restored terminal renders.

/** Safe ceiling below Chromium's ~16-context cap. Leaves headroom for any
 *  incidental contexts the renderer process may hold. */
export const MAX_WEBGL_CONTEXTS = 12;

interface PoolEntry {
  /** Load the WebGL addon for this terminal (idempotent — no-ops if loaded). */
  acquire: () => void;
  /** Dispose the WebGL addon for this terminal (idempotent — no-ops if gone).
   *  After this runs the terminal renders via xterm's DOM renderer. */
  dispose: () => void;
  /** True while this terminal currently holds a live WebGL context. */
  granted: boolean;
  /** Monotonic last-touch counter for LRU ordering. Higher = more recent. */
  seq: number;
}

/**
 * Pure, DOM-free LRU pool. All xterm/GPU side effects happen through the
 * `acquire`/`dispose` callbacks the caller supplies, so the eviction policy
 * is unit-testable in isolation (see webglContextPool.test.ts).
 */
export class WebglContextPool {
  private entries = new Map<string, PoolEntry>();
  private seqCounter = 0;
  private readonly max: number;

  constructor(max: number = MAX_WEBGL_CONTEXTS) {
    // Defensive: a non-positive budget would dead-lock every terminal on the
    // DOM renderer. Clamp to at least 1 so the focused terminal always gets GPU.
    this.max = Math.max(1, Math.floor(max));
  }

  /**
   * A visible terminal wants a WebGL context. Registers (or refreshes) its
   * callbacks, marks it most-recently-used, and grants a context — evicting
   * the least-recently-used granted terminal first when the budget is full.
   * Idempotent: calling again for an already-granted token just bumps its LRU
   * position (cheap; no GPU work).
   */
  acquire(token: string, acquire: () => void, dispose: () => void): void {
    let entry = this.entries.get(token);
    if (!entry) {
      entry = { acquire, dispose, granted: false, seq: 0 };
      this.entries.set(token, entry);
    } else {
      // Refresh callbacks — a remount reuses the token with new closures.
      entry.acquire = acquire;
      entry.dispose = dispose;
    }
    entry.seq = ++this.seqCounter;
    if (entry.granted) return;

    if (this.grantedCount() >= this.max) {
      this.evictLruExcept(token);
    }
    entry.granted = true;
    entry.acquire();
  }

  /**
   * A terminal became hidden (after the defer grace period) or unmounted.
   * Disposes its context if held and forgets it entirely. Safe to call for an
   * unknown token.
   */
  release(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    if (entry.granted) {
      entry.granted = false;
      try {
        entry.dispose();
      } catch {
        /* dispose must never throw out of the pool */
      }
    }
    this.entries.delete(token);
  }

  /**
   * The terminal's context was lost OUTSIDE the pool's control (a real GPU
   * driver reset firing webglcontextlost, not our controlled eviction). The
   * addon has already disposed itself. Free the accounting slot but KEEP the
   * entry so a later `acquire` (next visibility toggle) can re-grant. We do not
   * auto-re-acquire here: genuine context loss is rare and the DOM renderer
   * covers the gap until the next natural toggle, avoiding a thrash loop.
   */
  notifyDisposed(token: string): void {
    const entry = this.entries.get(token);
    if (!entry || !entry.granted) return;
    entry.granted = false;
  }

  /** Number of terminals currently holding a live context. */
  grantedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.granted) n++;
    return n;
  }

  /** Test/diagnostic hook: tokens that currently hold a context. */
  grantedTokens(): string[] {
    const out: string[] = [];
    for (const [token, e] of this.entries) if (e.granted) out.push(token);
    return out;
  }

  private evictLruExcept(exceptToken: string): void {
    let victim: string | null = null;
    let victimSeq = Infinity;
    for (const [token, e] of this.entries) {
      if (!e.granted || token === exceptToken) continue;
      if (e.seq < victimSeq) {
        victimSeq = e.seq;
        victim = token;
      }
    }
    if (victim === null) return; // nothing evictable (e.g. budget is 1)
    const entry = this.entries.get(victim)!;
    entry.granted = false;
    try {
      entry.dispose();
    } catch {
      /* dispose must never throw out of the pool */
    }
  }
}

/** Process-wide singleton — every terminal shares one budget. */
export const webglContextPool = new WebglContextPool();
