// ─── AO-style CI feedback routing (owner decision 2026-07-18) ────────────────
//
// The metadata poll already computes each pane's PR `checks` state every 5 s
// (passing | pending | failing | null). This router turns the passing/pending →
// FAILING transition into a ONE-SHOT `pr.ci` EventBus event so the deck's
// event-push coalescer can wake the owning orchestrator and (in auto/assist)
// drive the pane to a fix. It is the "detect → route back to the responsible
// worker" loop that competitors (Agent Orchestrator) ship and wmux lacked.
//
// EDGE-TRIGGERED, not level: we remember the last-seen `checks` per ptyId and
// fire ONLY on the transition INTO 'failing'. A PR that stays red across many
// poll ticks emits exactly once; it re-arms when checks leave 'failing' (a push
// flips it to pending/passing) so a later regression fires again. Without this
// the brain would be re-woken every 5 s for the same red PR.
//
// Pure of Electron: the workspace resolver and the emit sink are injected so the
// transition logic unit-tests with fakes. Production wiring lives in
// metadata.handler (resolver = findWorkspaceIdForPty over a cached workspace.list;
// sink = eventBus.emit). Resolution is async (renderer round-trip) but the map
// is written SYNCHRONOUSLY before the await, so an overlapping/next tick can't
// double-fire the same transition.

import type { PrStatus } from '../../shared/types';

type Checks = NonNullable<PrStatus['checks']> | 'none';

/** Resolve the owning workspace for a pty. Null = unresolved → event dropped
 *  (workspace isolation: a scope-less pr.ci must never leak across workspaces). */
export type WorkspaceResolver = (ptyId: string) => Promise<string | null> | string | null;

export interface PrCiEmit {
  workspaceId: string;
  ptyId: string;
  prNumber: number;
  url: string;
}

export class PrCiRouter {
  /** Last-seen checks state per ptyId (the edge-trigger memory). */
  private last = new Map<string, Checks>();

  constructor(
    private readonly resolveWorkspaceId: WorkspaceResolver,
    private readonly emit: (e: PrCiEmit) => void,
  ) {}

  /**
   * Record this pane's current PR status. Fires a `pr.ci` emit exactly once when
   * the checks state crosses INTO 'failing' from anything else (including the
   * first observation being red). A missing PR or absent checks re-arms the pane
   * without firing. Never throws — a resolver/emit error is swallowed so the
   * metadata poll is never disrupted.
   */
  async note(ptyId: string, pr: PrStatus | null): Promise<void> {
    const next: Checks = pr?.checks ?? 'none';
    const prev = this.last.get(ptyId) ?? 'none';
    // Write the new state FIRST (sync) so a concurrent/next tick sees 'failing'
    // and does not re-fire while the async resolve below is in flight.
    this.last.set(ptyId, next);
    if (next !== 'failing' || prev === 'failing') return;
    // A red PR needs a number + url to be actionable; the poll only ever yields
    // checks alongside a real PR, but guard anyway.
    if (!pr || typeof pr.number !== 'number' || !pr.url) return;
    try {
      const workspaceId = await this.resolveWorkspaceId(ptyId);
      if (!workspaceId) return; // unresolved → drop (isolation)
      this.emit({ workspaceId, ptyId, prNumber: pr.number, url: pr.url });
    } catch {
      /* resolver/emit failure must not break the poll — re-arm is undesirable
         (would spam on the next tick), so we keep `next` recorded and simply
         skip this emit. The transition is lost, not repeated. */
    }
  }

  /** Drop a pane's memory when it closes (poll prune parity). */
  forget(ptyId: string): void {
    this.last.delete(ptyId);
  }

  /** Test/observability peek. */
  lastChecks(ptyId: string): Checks {
    return this.last.get(ptyId) ?? 'none';
  }
}
