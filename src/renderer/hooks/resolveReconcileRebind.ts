/**
 * v2 RCA fix (reboot-reattach, axis B-lite) — pure decision for reconcile's
 * clear-vs-rebind step. Extracted from AppLayout.reconcilePtys so the policy is
 * unit-testable in isolation (no store / electron), mirroring reconcileWithReQuery.
 *
 * A `candidate` is a surface whose stored ptyId was ABSENT from the daemon's live
 * list. `toClear` is the 2-strike-confirmed-dead subset (absent from BOTH
 * snapshots). `liveList` is the daemon's live sessions — pass the SECOND
 * (re-query) snapshot when available so rebind targets are as fresh as the
 * clear decisions (review finding: a session that died between snapshots must
 * not be picked as a rebind target).
 *
 * Policy (review-hardened):
 *   - Only sessions carrying a surfaceId (WMUX_SURFACE_ID at create time —
 *     Terminal-self-create-originated) are rebind targets.
 *   - Duplicate claimants on one surfaceId: NEWEST createdAt wins (the binding
 *     the user last saw). Ties/missing createdAt keep the first encountered —
 *     deterministic either way. (oldest-wins was the naive Map behavior; three
 *     reviewers flagged it.)
 *   - A live pty is consumed by at most ONE candidate (no double-bind); a
 *     second candidate on the same surfaceId falls back to clear.
 *   - Candidates NOT in `toClear` (possibly live — absent from only one
 *     snapshot) yield NO action. Regression-critical invariant: reconcile never
 *     swaps a live-attached ptyId.
 */

export interface RebindCandidate {
  paneId: string;
  surfaceId: string;
  ptyId: string;
}

export interface LiveSessionInfo {
  id: string;
  surfaceId?: string;
  /** ISO 8601 create time — used to pick the newest duplicate claimant. */
  createdAt?: string;
}

export interface RebindAction {
  paneId: string;
  surfaceId: string;
  /** New ptyId to bind: a live session's id for 'rebind', '' for 'clear'. */
  newPtyId: string;
  kind: 'rebind' | 'clear';
  /** The dead ptyId being replaced — for logging/correlation and the caller's
   *  compare-and-swap guard (skip if the surface's ptyId moved on). */
  stalePtyId: string;
}

/** Newest-createdAt-wins map of surfaceId → live ptyId. Exported for tests. */
export function buildLiveBySurface(liveList: readonly LiveSessionInfo[]): Map<string, string> {
  const best = new Map<string, LiveSessionInfo>();
  for (const s of liveList) {
    if (!s.surfaceId) continue;
    const prev = best.get(s.surfaceId);
    if (!prev) {
      best.set(s.surfaceId, s);
      continue;
    }
    const prevT = prev.createdAt ? Date.parse(prev.createdAt) : NaN;
    const curT = s.createdAt ? Date.parse(s.createdAt) : NaN;
    // Strictly newer wins; ties and unparseable dates keep the incumbent.
    if (!Number.isNaN(curT) && (Number.isNaN(prevT) || curT > prevT)) {
      best.set(s.surfaceId, s);
    }
  }
  const map = new Map<string, string>();
  for (const [surfaceId, s] of best) map.set(surfaceId, s.id);
  return map;
}

export function resolveReconcileRebind(
  candidates: readonly RebindCandidate[],
  toClear: ReadonlySet<string>,
  liveList: readonly LiveSessionInfo[],
): RebindAction[] {
  const liveBySurface = buildLiveBySurface(liveList);
  const consumed = new Set<string>();
  const actions: RebindAction[] = [];
  for (const c of candidates) {
    // Only act on ptyIds CONFIRMED dead (absent from both daemon snapshots).
    // Anything else stays live and untouched — the core non-destructive invariant.
    if (!toClear.has(c.ptyId)) continue;
    const livePty = liveBySurface.get(c.surfaceId);
    if (livePty && !consumed.has(livePty)) {
      consumed.add(livePty);
      actions.push({ paneId: c.paneId, surfaceId: c.surfaceId, newPtyId: livePty, kind: 'rebind', stalePtyId: c.ptyId });
    } else {
      actions.push({ paneId: c.paneId, surfaceId: c.surfaceId, newPtyId: '', kind: 'clear', stalePtyId: c.ptyId });
    }
  }
  return actions;
}
