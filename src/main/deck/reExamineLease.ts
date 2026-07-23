// ─── Command Deck — re-examine turn lease (round-5 review P1) ────────────────
//
// `deck_resolve_decision` must be valid ONLY inside the heartbeat's re-examine
// turn — the per-spawn commander token alone cannot carry that, because it is
// valid across EVERY turn of the brain's session. Without a turn-scoped check,
// any ordinary turn (a human DECK_SEND chat while a stale decision is pending)
// could pass the mode/TTL/substance gates and self-resolve outside the
// re-examine framing — bypassing the human-decision gate the operator expects.
//
// The lease is a plain in-memory map (main process only — the deck RPC handlers
// run in the same process): granted by runTurnForWorkspace when a re-examine
// turn actually starts, bound to (workspaceId → decisionId), revoked in the
// turn's finally. Deliberately NOT persisted: a lease must die with the turn
// (and with the process — after a restart no re-examine turn is live, so no
// self-resolve until the heartbeat fires a fresh one).

const leases = new Map<string, string>();

/** Grant the re-examine lease for one workspace's decision. At most one per
 *  workspace — a new grant replaces the old (a workspace runs one turn at a
 *  time, enforced by the manager's busy check). */
export function grantReExamineLease(workspaceId: string, decisionId: string): void {
  leases.set(workspaceId, decisionId);
}

/** Revoke the workspace's lease (turn ended — success, error, or abort). */
export function revokeReExamineLease(workspaceId: string): void {
  leases.delete(workspaceId);
}

/** True only while a re-examine turn for EXACTLY this decision is running. */
export function hasReExamineLease(workspaceId: string, decisionId: string): boolean {
  return leases.get(workspaceId) === decisionId;
}

export function __resetReExamineLeasesForTesting(): void {
  leases.clear();
}
