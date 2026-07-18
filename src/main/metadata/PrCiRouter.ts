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
  /** Last-seen checks state + PR identity per ptyId (the edge-trigger memory).
   *  The PR number is part of the edge (CodeRabbit, PR #496): a pane that jumps
   *  straight from failing PR A to failing PR B is a NEW red PR and must fire,
   *  even though the checks state never left 'failing'. */
  private last = new Map<string, { checks: Checks; prNumber: number | null }>();

  constructor(
    private readonly resolveWorkspaceId: WorkspaceResolver,
    private readonly emit: (e: PrCiEmit) => void,
  ) {}

  /**
   * Record this pane's current PR status. Fires a `pr.ci` emit exactly once when
   * the checks state crosses INTO 'failing' — from anything else, from no PR, or
   * from a DIFFERENT PR that was also failing. A missing PR or absent checks
   * re-arms the pane without firing. Never throws — a resolver/emit error is
   * swallowed so the metadata poll is never disrupted; on failure the previous
   * state is RESTORED so the next poll tick retries the same transition
   * (a transient renderer-resolution hiccup must not permanently eat the red).
   */
  async note(ptyId: string, pr: PrStatus | null): Promise<void> {
    const next: Checks = pr?.checks ?? 'none';
    const nextNumber = typeof pr?.number === 'number' ? pr.number : null;
    const prevEntry = this.last.get(ptyId);
    const prev = prevEntry?.checks ?? 'none';
    // Write the new state FIRST (sync) so a concurrent/next tick sees 'failing'
    // and does not re-fire while the async resolve below is in flight.
    this.last.set(ptyId, { checks: next, prNumber: nextNumber });
    const samePr = prevEntry !== undefined && prevEntry.prNumber === nextNumber;
    if (next !== 'failing' || (prev === 'failing' && samePr)) return;
    // A red PR needs a number + url to be actionable; the poll only ever yields
    // checks alongside a real PR, but guard anyway.
    if (!pr || typeof pr.number !== 'number' || !pr.url) return;
    try {
      const workspaceId = await this.resolveWorkspaceId(ptyId);
      if (!workspaceId) throw new Error('unresolved');
      this.emit({ workspaceId, ptyId, prNumber: pr.number, url: pr.url });
    } catch {
      // Restore the pre-transition state so the next tick re-attempts the SAME
      // edge instead of the red being permanently lost to a transient failure.
      // Bounded: each retry is one (cached) workspace.list resolve per 5 s
      // tick, and emits never duplicate because the edge only fires on success.
      if (prevEntry) this.last.set(ptyId, prevEntry);
      else this.last.delete(ptyId);
    }
  }

  /** Drop a pane's memory when it closes (poll prune parity). */
  forget(ptyId: string): void {
    this.last.delete(ptyId);
  }

  /** Test/observability peek. */
  lastChecks(ptyId: string): Checks {
    return this.last.get(ptyId)?.checks ?? 'none';
  }
}
