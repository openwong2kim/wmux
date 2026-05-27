// LegacyTrafficCounter — per-method call counter for envelope-less RPCs
// (Phase 2.2 pre-commit 4).
//
// Why: RpcRouter's pre-Phase-2.2 legacy bookkeeping was process-once — the
// trust DB gets a single `legacy` row per process and that's it. Useful for
// "did legacy traffic happen at all?" but useless for "which methods are
// the biggest legacy hot-paths?" — exactly the question v3.1's user-facing
// "your old plugins are calling these RPCs" panel needs answered.
//
// This counter accumulates per-method counts in memory and flushes milestones
// (1st, 10th, 100th, 1000th, 10000th call) to the shadow audit log so v3.1
// can build the surfacing UI on real data without needing a long-running
// telemetry pipeline. Counts above the last milestone keep accumulating in
// memory but stop emitting log entries (preventing log spam under heavy
// legacy traffic) — the in-memory value can still be inspected via
// `getCount`.
//
// Bounded: a hostile / pathological caller cycling through RPC methods
// can't grow the counter map unboundedly. The map size is capped; once
// at cap, additional method names are dropped on the floor.

import type { RpcMethod } from '../../shared/rpc';

/** Sink invoked when a method's count crosses a milestone threshold. */
export type LegacyTrafficSink = (input: {
  method: RpcMethod;
  count: number;
}) => void;

/** Counts at which a sink call fires. Geometric so log spam stays bounded. */
export const DEFAULT_MILESTONES: readonly number[] = [1, 10, 100, 1000, 10000];

/**
 * Cap on the number of distinct methods tracked. The wire surface is ~96
 * methods today; a buggy or hostile caller fuzzing method names can't
 * inflate the map past this. Excess methods are simply not recorded —
 * acceptable since the counter is best-effort telemetry, not gating logic.
 */
export const MAX_TRACKED_METHODS = 256;

export interface LegacyTrafficCounterOptions {
  sink?: LegacyTrafficSink;
  milestones?: readonly number[];
  maxTrackedMethods?: number;
}

export class LegacyTrafficCounter {
  private readonly counts = new Map<RpcMethod, number>();
  private readonly sink: LegacyTrafficSink | undefined;
  private readonly milestones: ReadonlySet<number>;
  private readonly maxMethods: number;

  constructor(options: LegacyTrafficCounterOptions = {}) {
    this.sink = options.sink;
    this.milestones = new Set(options.milestones ?? DEFAULT_MILESTONES);
    this.maxMethods = options.maxTrackedMethods ?? MAX_TRACKED_METHODS;
  }

  /**
   * Record one envelope-less call. If the resulting count is one of the
   * configured milestones, fire the sink. Sink errors are swallowed —
   * audit telemetry must never affect RPC throughput.
   */
  record(method: RpcMethod): void {
    const existing = this.counts.get(method);
    if (existing === undefined && this.counts.size >= this.maxMethods) {
      // Tracked-method cap reached; drop this new method on the floor.
      return;
    }
    const next = (existing ?? 0) + 1;
    this.counts.set(method, next);
    if (this.milestones.has(next) && this.sink) {
      try {
        this.sink({ method, count: next });
      } catch {
        /* swallow */
      }
    }
  }

  /** Test/observability helper. */
  getCount(method: RpcMethod): number {
    return this.counts.get(method) ?? 0;
  }

  /** Test helper — drops all state. */
  reset(): void {
    this.counts.clear();
  }
}
