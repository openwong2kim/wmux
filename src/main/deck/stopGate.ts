// ─── Stop gate — refuse to end an orchestrator turn with work outstanding ────
//
// The terminal orchestrator's failure mode is ending its turn the moment it has
// dispatched work: it delegates to a worker pane, says "delegated", and stops.
// Nothing then drives the fleet until a wake event happens to fire. This module
// is the predicate that answers ONE question — "does the fleet still have panes
// that need this brain?" — and the answer rides the `hooks.signal` RPC response
// back to the bridge, which turns a block into exit 2 (Claude Code's "keep
// going" contract for a Stop hook).
//
// Pure and dependency-free on purpose: the whole gate is unit-testable without
// a mirror, a pty, or a claude. Everything stateful (the consecutive-block
// counter, the snapshot lookup) lives in the adapter that calls this.
//
// Three fail-open rules, all deliberate:
//   1. A null snapshot never blocks. The gate INFERS outstanding work from pane
//      status; a derived signal cannot prove absence, so a missing or stale
//      mirror must not wedge the brain.
//   2. A stale snapshot is treated as a null one. The mirror is pushed by the
//      renderer, so a backgrounded/wedged/reloading renderer leaves the last
//      push sitting in main indefinitely. Blocking a turn on panes that were
//      "running" a quarter of an hour ago is a trap, not a gate — the same
//      rule 1 reasoning, applied to a snapshot that merely LOOKS present.
//   3. A run of consecutive blocks is capped. A model that cannot resolve a
//      parked pane would otherwise be refused until TURN_TIMEOUT_MS (30 min),
//      which ends in the worst possible way — an ESC into the TUI and a
//      superseded-turn credit. The cap is what makes this a gate and not a
//      trap, so the deadlock-avoidance it buys is worth the turns it lets
//      through: a wrongly-allowed Stop costs one wake event, a wrongly-held
//      turn costs the whole fleet its orchestrator.

import type { FleetSnapshot, FleetSnapshotPane } from '../../shared/workspaceMirror';

/** Default ceiling on consecutive refusals for one turn. */
export const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 3;

/** How old a fleet snapshot may be and still be trusted to hold a turn open.
 *  Comfortably above the renderer's push cadence, well below the point where
 *  "running" means "was running when the renderer last got a frame". */
export const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30_000;

export type StopGateVerdict =
  | { block: false }
  /**
   * `outstandingPtyIds` is the set of panes this refusal is actually about, and
   * it is EMPTY for a block that names none — an active-work hold with a
   * missing or stale snapshot. `input.rpc` protects exactly this set (#733), so
   * it has to travel with the verdict rather than be re-derived by the caller:
   * a caller re-reading a stale snapshot would protect panes the model was
   * never told about, which is the drift this field exists to make impossible.
   */
  | { block: true; reason: string; outstandingPtyIds: string[] };

/** Pane statuses that mean "this pane still needs the orchestrator". The same
 *  attention set CommanderEventCoalescer treats as non-quiescent. */
function isOutstanding(status: FleetSnapshotPane['agentStatus']): boolean {
  return status === 'running' || status === 'awaiting_input';
}

/** Short human label for one blocking pane, used in the reason string. */
function describePane(pane: FleetSnapshotPane): string {
  const name = pane.agentName && pane.agentName.length > 0 ? pane.agentName : pane.ptyId;
  return `${name} (${pane.agentStatus})`;
}

/**
 * Decide whether this Stop may end the turn.
 *
 * Brain ptys are not in the snapshot — they carry ENV_KEYS.BRAIN_PTY and are
 * filtered out of every pane listing — so the gate can never block on the
 * orchestrator's own session. That is asserted in the tests rather than trusted.
 */
export function evaluateStopGate(input: {
  /** `getWorkspaceMirror().getFleetSnapshot(workspaceId)`, or null when absent. */
  snapshot: FleetSnapshot | null;
  /** A durable human request that still belongs to this commander. Unlike pane
   *  state, this is authoritative even when the renderer snapshot is absent. */
  activeWork?: { id: string } | null;
  /** How many times in a row this turn's Stop has already been refused. */
  consecutiveBlocks: number;
  maxConsecutiveBlocks?: number;
  /** Injectable clock, so the staleness rule is testable without waiting. */
  now?: number;
  maxSnapshotAgeMs?: number;
}): StopGateVerdict {
  const { snapshot, activeWork } = input;
  const max = input.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS;
  if (input.consecutiveBlocks >= max) return { block: false };

  // A durable active-work record is stronger than the renderer-derived pane
  // snapshot. Even with no/freshness-lost snapshot, give the brain a bounded
  // chance to explicitly finalize the request instead of silently ending its
  // turn. The consecutive-block cap above still prevents a broken tool/store
  // from trapping the TUI indefinitely.
  const finalizeReason = activeWork
    ? `The human request ${activeWork.id} is still ACTIVE. Do not claim completion or end yet. ` +
      'Inspect the delegated results and acceptance checks; when everything is actually complete, call ' +
      'deck_complete_work({summary, verification}). If work remains, delegate or unblock the next step.'
    : null;
  if (!snapshot) {
    return finalizeReason ? { block: true, reason: finalizeReason, outstandingPtyIds: [] } : { block: false };
  }
  // Staleness means pane state cannot be used to infer outstanding workers. An
  // active-work record can still hold the turn because it is durable runtime
  // state rather than a stale renderer inference.
  const maxAge = input.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  const age = (input.now ?? Date.now()) - snapshot.ts;
  if (age > maxAge) {
    return finalizeReason ? { block: true, reason: finalizeReason, outstandingPtyIds: [] } : { block: false };
  }

  const outstanding = snapshot.panes.filter((p) => isOutstanding(p.agentStatus));
  if (outstanding.length === 0) {
    return finalizeReason ? { block: true, reason: finalizeReason, outstandingPtyIds: [] } : { block: false };
  }

  // This string is the ONLY thing the model reads about the refusal, so it
  // names the panes, their statuses, and the action that clears the gate.
  //
  // It also has to name what NOT to do. Issue #733: a pane wedged at `running`
  // held the gate, and the brain escalated to `exit` and then Ctrl+D on a live
  // user shell — reading "resolve the pane" as "end the pane". A reported
  // status is not resolved by killing the thing it describes, and the pane
  // belongs to a human who did not ask for it to close. `input.rpc` enforces
  // this for the panes named here; the sentence exists so the model does not
  // have to learn it by being refused.
  const list = outstanding.map(describePane).join(', ');
  const noun = outstanding.length === 1 ? 'pane' : 'panes';
  return {
    block: true,
    outstandingPtyIds: outstanding.map((p) => p.ptyId),
    reason:
      `Do not end this turn yet: ${outstanding.length} worker ${noun} still need you — ${list}. ` +
      'Check each one (read its screen, answer what it is waiting on, or delegate the next step). ' +
      'Do NOT close or kill a pane to clear its status — no exit, no Ctrl+D, no kill. ' +
      'Those sessions belong to the human. If a pane will not resolve, leave it running and ' +
      'raise it with deck_ask_decision instead of ending it. ' +
      (finalizeReason ?? 'If there is genuinely nothing left for you to do, say so and stop again.'),
  };
}
