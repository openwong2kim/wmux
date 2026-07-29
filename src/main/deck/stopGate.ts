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
// Two fail-open rules, both deliberate:
//   1. A null snapshot never blocks. The gate INFERS outstanding work from pane
//      status; a derived signal cannot prove absence, so a missing or stale
//      mirror must not wedge the brain.
//   2. A run of consecutive blocks is capped. A model that cannot resolve a
//      parked pane would otherwise be refused until TURN_TIMEOUT_MS (30 min),
//      which ends in the worst possible way — an ESC into the TUI and a
//      superseded-turn credit. The cap is what makes this a gate and not a trap.

import type { FleetSnapshot, FleetSnapshotPane } from '../../shared/workspaceMirror';

/** Default ceiling on consecutive refusals for one turn. */
export const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 3;

export type StopGateVerdict = { block: false } | { block: true; reason: string };

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
  /** How many times in a row this turn's Stop has already been refused. */
  consecutiveBlocks: number;
  maxConsecutiveBlocks?: number;
}): StopGateVerdict {
  const { snapshot } = input;
  if (!snapshot) return { block: false };
  const max = input.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS;
  if (input.consecutiveBlocks >= max) return { block: false };

  const outstanding = snapshot.panes.filter((p) => isOutstanding(p.agentStatus));
  if (outstanding.length === 0) return { block: false };

  // This string is the ONLY thing the model reads about the refusal, so it
  // names the panes, their statuses, and the action that clears the gate.
  const list = outstanding.map(describePane).join(', ');
  const noun = outstanding.length === 1 ? 'pane' : 'panes';
  return {
    block: true,
    reason:
      `Do not end this turn yet: ${outstanding.length} worker ${noun} still need you — ${list}. ` +
      'Check each one (read its screen, answer what it is waiting on, or delegate the next step), ' +
      'then finish. If there is genuinely nothing left for you to do, say so and stop again.',
  };
}
