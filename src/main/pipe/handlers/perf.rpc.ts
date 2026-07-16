import type { RpcRouter } from '../RpcRouter';
import { revealStatsAggregator } from '../../perf/revealStatsAggregator';

export function registerPerfRpc(router: RpcRouter): void {
  /**
   * perf.status — read-only performance diagnostics for `wmux doctor
   * --performance` (P0-5c).
   *
   * Returns: {
   *   retention: {
   *     last:      RevealEvent & { ageMs } | null   — most recent reveal
   *     last5m:    Record<mechanism, count>          — trailing 5-minute window
   *     sinceBoot: Record<mechanism, count>          — since main-process boot
   *   }
   * }
   *
   * The data is the aggregate of the renderer's `[wmux:reveal]` console
   * diagnostics (mechanism codes: retained-catchup / dirty-snapshot /
   * dirty-raw-fallback / dead-snapshot / resync-degraded) as relayed to main
   * by the console-message handler in src/main/index.ts. Counters + ptyIds
   * only — never terminal content.
   */
  router.register('perf.status', (_params) => {
    return Promise.resolve({ retention: revealStatsAggregator.getStats() });
  });
}
