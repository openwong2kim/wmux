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

// ─── Cap-out hysteresis (stop gate rule 5) ───────────────────────────────────
//
// The consecutive-block counter lives on the brain adapter and dies with the
// turn, so a wake loop over UNCHANGED fleet state re-bought the same three
// refusals — three re-printed turns — every cycle. This records what the gate
// was holding on when it capped out (the verdict's `cappedOutFingerprint`), so
// the next turn's gate can stay quiet until the state actually changes.
//
// Cleared three ways, each deliberate:
//   - fingerprint mismatch: the gate compares fresh state itself, so any real
//     change (a follow-up, an A2A transition, a pane flipping status) re-arms
//     it with no call here;
//   - a human turn (beginTrackedWork): the human spoke, the brain owes the
//     fleet a fresh look even if nothing else moved;
//   - the TTL below: a truly wedged fleet still gets a rate-limited reminder
//     instead of silence forever.

/** How long a cap-out suppression holds. Three refusals per this window on a
 *  wedged, unchanging fleet — versus three per wake cycle without it. */
export const GATE_CAP_SUPPRESSION_TTL_MS = 15 * 60_000;

interface CapOut {
  fingerprint: string;
  at: number;
}

const capOuts = new Map<string, CapOut>();

/** Record that `workspaceId`'s gate capped out while holding on `fingerprint`
 *  (the allow verdict's `cappedOutFingerprint`). Last write wins. */
export function noteGateCapOut(
  workspaceId: string,
  fingerprint: string,
  now: number = Date.now(),
): void {
  capOuts.set(workspaceId, { fingerprint, at: now });
}

/** The fingerprint whose re-block is currently suppressed, or null. Fail-open
 *  like the holds: unknown workspace or an expired record reads as null, and
 *  the gate simply re-arms — a wrongly-expired suppression costs at most one
 *  more capped refusal run. */
export function suppressedGateFingerprint(
  workspaceId: string,
  now: number = Date.now(),
): string | null {
  const rec = capOuts.get(workspaceId);
  if (!rec) return null;
  if (now - rec.at > GATE_CAP_SUPPRESSION_TTL_MS) {
    capOuts.delete(workspaceId);
    return null;
  }
  return rec.fingerprint;
}

/** Re-arm the gate: a human turn landed, or the commander was retired. */
export function clearGateCapOut(workspaceId: string): void {
  capOuts.delete(workspaceId);
}

/** Test seam. */
export function resetGateCapOuts(): void {
  capOuts.clear();
}
