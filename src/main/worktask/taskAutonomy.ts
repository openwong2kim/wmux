// ─── Fan-out task workspaces inherit their owner's autonomy (A-2 precondition) ─
//
// `decideApprovalPress` refuses an automated press unless the target pane's
// workspace is a task workspace AND that workspace's stored `approvalPress`
// capability is on. A fan-out used to create task workspaces with NO autonomy
// entry at all, and a missing entry reads as the product default (mode `off`,
// every capability false) — so `approval.press` would have refused every worker
// a brain ever spawned, with `press-capability-off`, no matter how the operator
// had configured the workspace they launched the fan-out from.
//
// So the task workspace inherits the OWNER's mode at creation.
//
// ── Why inherit the mode, and not invent a "delegated press" ────────────────
//
// The wave-2 plan left the choice open: give a task workspace press because its
// owner delegated the work, or keep the mode's own meaning. It keeps the mode's
// meaning. `modeToCaps` is the single place that says what a mode allows, and
// the operator's own UI states it: `assist` launches the agent with edits
// auto-accepted and EVERY other permission prompt still stopping it. A
// capability that turned press on for an `assist` owner would contradict the
// readout that operator is looking at — and the brain is given that same
// autonomy line by the coalescer, so it would also contradict what the brain
// was told about itself.
//
// The consequence is deliberate and documented for the dogfood: an owner in
// `assist` gets workers whose approvals a brain may NOT press. The brain is not
// stuck there — `approval.press` answers with the refusal reason, the typed
// fallback is re-opened for that pane, and `deck_ask_decision` raises it to the
// human. An owner who wants unattended presses runs in `danger`, which is the
// mode that already means "nothing prompts".
//
// An owner in `off` writes NOTHING: `off` is also what an absent entry means, so
// a row would only add noise to deck-autonomy.json and to the fact table.

import {
  DEFAULT_MODE,
  loadWorkspaceMode,
  setWorkspaceMode,
  type AgentMode,
} from '../deck/deckAutonomyStore';

export interface InheritTaskAutonomyResult {
  /** The mode the task workspace ended up with. */
  mode: AgentMode;
  /** False when nothing was written (owner had no autonomy to pass on). */
  written: boolean;
}

/**
 * Give `taskWorkspaceId` the autonomy its owner has. Never throws — a fan-out
 * that cannot write this still spawns; its workers simply cannot have their
 * approvals pressed, which is the safe direction.
 */
export async function inheritTaskAutonomy(
  ownerWorkspaceId: string,
  taskWorkspaceId: string,
  dir?: string,
): Promise<InheritTaskAutonomyResult> {
  const ownerMode = loadWorkspaceMode(ownerWorkspaceId, dir);
  if (ownerMode === DEFAULT_MODE) return { mode: DEFAULT_MODE, written: false };
  try {
    const entry = await setWorkspaceMode(taskWorkspaceId, ownerMode, dir);
    return { mode: entry.mode, written: true };
  } catch (err) {
    console.warn(
      `[fanout] could not give task workspace ${taskWorkspaceId} its owner's autonomy: ${String(err)}`,
    );
    return { mode: DEFAULT_MODE, written: false };
  }
}
