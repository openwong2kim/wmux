// ─── Which panes are currently holding a workspace's Stop gate ──────────────
//
// Issue #733: a pane wedged at `running` held the gate open, and the brain
// escaped by running `exit` and then Ctrl+D in that pane — killing a live shell
// the human owned. The refusal text now forbids that, but prose is not a
// control: the brain is a separate `claude` process and can ignore it.
//
// This module is the enforcement half. `stopGate` already computes exactly the
// set of panes it is blocking on, so recording that set costs nothing and lets
// `input.rpc` refuse the one action that turned a status bug into data loss:
// session-terminating input, aimed at a pane the caller is currently blocked
// on. Everything else is untouched — an orchestrator that is not gate-held may
// close shells freely, and even a gate-held one may close panes it is not
// blocked on.
//
// The record is deliberately short-lived. A gate verdict is a statement about
// one moment; the failure mode we just fixed came from state that outlived its
// meaning and was never re-checked, so this one expires on its own rather than
// waiting for something to clear it.

/** How long a recorded verdict is trusted. A Stop gate decision is re-made on
 *  every Stop, which is far more often than this — the TTL only bounds how long
 *  a crashed or abandoned turn can keep panes protected. */
export const GATE_VERDICT_TTL_MS = 60_000;

interface GateHold {
  ptyIds: Set<string>;
  at: number;
}

const holds = new Map<string, GateHold>();

/**
 * Record the outcome of one Stop-gate evaluation. Pass the panes the gate named
 * as outstanding, or an empty list / null when the turn was allowed to end.
 */
export function noteGateVerdict(
  workspaceId: string,
  outstandingPtyIds: readonly string[] | null,
  now: number = Date.now(),
): void {
  if (!outstandingPtyIds || outstandingPtyIds.length === 0) {
    holds.delete(workspaceId);
    return;
  }
  holds.set(workspaceId, { ptyIds: new Set(outstandingPtyIds), at: now });
}

/**
 * Is `ptyId` one of the panes currently holding `workspaceId`'s Stop gate?
 * False for an unknown workspace, an expired verdict, or a pane the gate did
 * not name — the guard fails OPEN, because wrongly refusing a legitimate write
 * is worse than the narrow case it protects.
 */
export function isGateHeldOn(
  workspaceId: string,
  ptyId: string,
  now: number = Date.now(),
): boolean {
  const hold = holds.get(workspaceId);
  if (!hold) return false;
  if (now - hold.at > GATE_VERDICT_TTL_MS) {
    holds.delete(workspaceId);
    return false;
  }
  return hold.ptyIds.has(ptyId);
}

/** Drop a workspace's record — called when its commander session is replaced. */
export function clearGateVerdict(workspaceId: string): void {
  holds.delete(workspaceId);
}

/** Test seam. */
export function resetGateVerdicts(): void {
  holds.clear();
}
