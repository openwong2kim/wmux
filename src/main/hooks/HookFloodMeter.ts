/**
 * HookFloodMeter — postmortem-visible observability for the hook-RPC path.
 *
 * RCA (2026-05-29 user dogfood): a tool-heavy turn flooded the bridge with 2s
 * timeouts because every hook did a renderer workspace.list round-trip. The
 * A1 fix (short-TTL + coalescing cache in hooks.rpc) collapses the round-trips,
 * but the maintainer was flying blind: the flood was only visible by manually
 * tallying bridge.log. This meter tracks, in a rolling window, how many hook
 * signals experienced a SLOW or FAILED workspace.list fetch (= renderer
 * throttled / event loop busy — the flood precursor) and emits one summary log
 * line per window so a postmortem (or live tail) shows the flood directly.
 *
 * Pure + dependency-free so it unit-tests without electron/IPC. The periodic
 * flush + log wiring lives in hooks.rpc (registerHooksRpc).
 */

export interface HookFloodSample {
  /** True when the workspace.list fetch was slow or failed (renderer slow). */
  degraded: boolean;
  /** Wall-clock ms the workspace.list resolution took for this signal. */
  fetchMs: number;
  /**
   * True when the signal was served from the env-routed cache fast path (Fix B)
   * with NO renderer round-trip. Without counting these, a real flush storm
   * reads as "0 degraded" because the ptyId hooks bypass the fetch entirely —
   * the meter would go green precisely when the renderer is most saturated
   * (GLM P2). Surfacing the count keeps that visible.
   */
  fastPathed?: boolean;
}

export interface HookFloodSummary {
  windowMs: number;
  total: number;
  degraded: number;
  maxFetchMs: number;
  fastPathed: number;
}

export class HookFloodMeter {
  private total = 0;
  private degraded = 0;
  private maxFetchMs = 0;
  private fastPathed = 0;

  record(sample: HookFloodSample): void {
    this.total++;
    if (sample.degraded) this.degraded++;
    if (sample.fetchMs > this.maxFetchMs) this.maxFetchMs = sample.fetchMs;
    if (sample.fastPathed) this.fastPathed++;
  }

  /**
   * Snapshot the current window and RESET. Returns null when no signals were
   * recorded in the window (so the logger stays silent on an idle wmux instead
   * of emitting a "0 signals" line every interval).
   */
  flush(windowMs: number): HookFloodSummary | null {
    if (this.total === 0) return null;
    const summary: HookFloodSummary = {
      windowMs,
      total: this.total,
      degraded: this.degraded,
      maxFetchMs: this.maxFetchMs,
      fastPathed: this.fastPathed,
    };
    this.total = 0;
    this.degraded = 0;
    this.maxFetchMs = 0;
    this.fastPathed = 0;
    return summary;
  }
}

/**
 * Format a window summary into a log line + level. Warns when a meaningful
 * fraction of signals were degraded (a real flood, not a one-off slow fetch).
 */
export function describeHookFlood(s: HookFloodSummary): { level: 'info' | 'warn'; message: string } {
  const secs = Math.round(s.windowMs / 1000);
  const pct = s.total > 0 ? Math.round((s.degraded / s.total) * 100) : 0;
  const base = `[hooks] last ${secs}s: ${s.total} signals, ${s.degraded} degraded (${pct}% slow/failed workspace.list), ${s.fastPathed} fast-pathed (cache, no renderer RTT), maxFetch ${s.maxFetchMs}ms`;
  // Flood = a non-trivial sample AND ≥10% degraded. Below that, a stray slow
  // fetch is noise, not a pattern worth a warning.
  const isFlood = s.total >= 10 && s.degraded / s.total >= 0.1;
  return isFlood
    ? { level: 'warn', message: `${base} — possible hook-RPC flood (renderer slow/throttled or event loop busy)` }
    : { level: 'info', message: base };
}
