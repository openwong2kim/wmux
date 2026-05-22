// SignalLatencyMeter — local-only health observability for hook signals.
//
// Records the delta between (agent hook fire time, captured by the bridge
// script and carried in AgentSignal.ts) and (wmux receive time, captured
// here). Stored in a fixed-size ring buffer in memory. Surfaced to the
// renderer via uiSlice for the "Plugin signal health" card and used by
// HookOnboardingBanner to detect stale plugin state.
//
// No telemetry. No disk persistence. No remote upload. Buffer contents
// die with the process. The whole point is to give the user a local
// diagnostic without crossing any privacy boundary.
//
// ASCII diagram of data flow:
//
//   Bridge captures ts = Date.now()
//      │ (RPC: hooks.signal)
//      ▼
//   HookSignalRouter.dispatch()
//      │ calls SignalLatencyMeter.recordSignal(signal.ts, now)
//      ▼
//   ring buffer (max 100 entries, oldest evicted)
//      │
//      ▼
//   uiSlice reads getStats() periodically (or push on update)
//      │
//      ▼
//   Settings → ClaudeIntegrationSection "Signal health" card

import type { AgentSlug } from '../../../integrations/shared/signal-types';

/** Single observed (hook-fire → wmux-receive) delta. */
export interface LatencyEntry {
  agent: AgentSlug;
  /** Hook fire time (Unix ms) as reported by the bridge. */
  fireTs: number;
  /** wmux receive time (Unix ms) captured by HookSignalRouter. */
  receiveTs: number;
  /** Derived: receiveTs - fireTs. Negative deltas are clamped to 0 (clock skew). */
  deltaMs: number;
}

/** Aggregate query result. All numeric fields are null when buffer empty. */
export interface LatencyStats {
  /** Total entries observed since process start (NOT buffer size). */
  total: number;
  /** Current buffer fill count (≤ MAX_BUFFER). */
  count: number;
  /** Median delta in ms. Null when buffer empty. */
  p50: number | null;
  /** 95th percentile delta in ms. Null when buffer empty. */
  p95: number | null;
  /** Most recent receiveTs. Null when buffer empty. */
  lastSignalAt: number | null;
  /** Per-agent breakdown of fill counts. */
  perAgent: Partial<Record<AgentSlug, number>>;
}

/** Fixed ring buffer capacity. Chosen so the structure is bounded at
 *  ~8KB resident even with all fields, well under any reasonable budget. */
export const MAX_BUFFER = 100;

/**
 * Single-writer in-process ring buffer. Not thread-safe across workers —
 * use only from the main process. HookSignalRouter is the sole writer.
 * Multiple readers (uiSlice query, isStale check) are fine because reads
 * snapshot the array index.
 */
export class SignalLatencyMeter {
  private readonly entries: LatencyEntry[] = [];
  /** Write index modulo MAX_BUFFER. */
  private writeIdx = 0;
  /** Lifetime emission count, never decremented. */
  private totalSeen = 0;

  /**
   * Record a single hook arrival.
   *
   * @param agent      Canonical agent slug (from AgentSignal.agent).
   * @param fireTs     Bridge-reported hook fire time (Unix ms).
   * @param receiveTs  Optional override (default Date.now()). Tests inject.
   */
  recordSignal(agent: AgentSlug, fireTs: number, receiveTs?: number): void {
    const now = receiveTs ?? Date.now();
    // Clamp negative deltas. Bridge clock could be skewed slightly behind
    // wmux clock; we'd rather report 0 than a misleading negative.
    const deltaMs = Math.max(0, now - fireTs);
    const entry: LatencyEntry = {
      agent,
      fireTs,
      receiveTs: now,
      deltaMs,
    };
    if (this.entries.length < MAX_BUFFER) {
      this.entries.push(entry);
    } else {
      this.entries[this.writeIdx] = entry;
    }
    this.writeIdx = (this.writeIdx + 1) % MAX_BUFFER;
    this.totalSeen += 1;
  }

  /**
   * Snapshot the current buffer state. O(n log n) due to sort; n ≤ 100
   * so this is fine to call on every Settings panel render.
   */
  getStats(): LatencyStats {
    const count = this.entries.length;
    if (count === 0) {
      return {
        total: this.totalSeen,
        count: 0,
        p50: null,
        p95: null,
        lastSignalAt: null,
        perAgent: {},
      };
    }

    // Sort a COPY of deltas — never mutate the buffer order, that would
    // wreck the ring write index semantics.
    const sortedDeltas = this.entries.map((e) => e.deltaMs).slice().sort((a, b) => a - b);
    const p50 = percentile(sortedDeltas, 0.5);
    const p95 = percentile(sortedDeltas, 0.95);

    // Latest receiveTs across the whole buffer. We don't track this as
    // a separate field because the ring rewrites in place; scanning is
    // cheap at n=100.
    let lastSignalAt = -Infinity;
    const perAgent: Partial<Record<AgentSlug, number>> = {};
    for (const e of this.entries) {
      if (e.receiveTs > lastSignalAt) lastSignalAt = e.receiveTs;
      perAgent[e.agent] = (perAgent[e.agent] ?? 0) + 1;
    }

    return {
      total: this.totalSeen,
      count,
      p50,
      p95,
      lastSignalAt: lastSignalAt === -Infinity ? null : lastSignalAt,
      perAgent,
    };
  }

  /**
   * True when the buffer is currently empty, OR the most-recent receive
   * timestamp is older than `thresholdMs`. Buffer-empty returns true
   * regardless of `totalSeen` because the ring is never trimmed in
   * practice — these conditions are equivalent at runtime, but the
   * docstring matches the implementation so a future entry-expiry
   * refactor doesn't silently invert the contract.
   *
   * Caller distinguishes "plugin never installed" from "plugin stopped
   * firing" via `getStats().total` (lifetime count, never decremented).
   */
  isStale(thresholdMs: number, now: number = Date.now()): boolean {
    if (this.entries.length === 0) return true;
    const stats = this.getStats();
    if (stats.lastSignalAt === null) return true;
    return now - stats.lastSignalAt > thresholdMs;
  }

  /** Test-only: clear all state. NOT exposed to production callers. */
  resetForTests(): void {
    this.entries.length = 0;
    this.writeIdx = 0;
    this.totalSeen = 0;
  }
}

/**
 * Linear-interpolation percentile over a sorted ascending array.
 * Standard inclusive method (matches numpy's default). Returns the
 * single element when array length is 1.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}
