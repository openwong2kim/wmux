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
// stuck there — `approval.press` answers with the refusal reason and
// `deck_ask_decision` raises it to the human; typing at the prompt stays
// blocked. An owner who wants unattended presses runs in `danger`, which is the
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
    // `setWorkspaceMode` REFUSES rather than throws: a workspace id that fails
    // its pattern, or a mode it does not recognise, comes back as the product
    // default with nothing written. Reporting that as `written: true` claimed
    // the inheritance landed while `decideApprovalPress` was about to refuse
    // every press into the worker — a fan-out that looks configured and is not
    // is worse than one that says it failed.
    if (entry.mode !== ownerMode) {
      console.warn(
        `[fanout] autonomy inheritance refused for task workspace ${taskWorkspaceId}: ` +
          `asked for '${ownerMode}', the store answered '${entry.mode}' — ` +
          'the worker keeps the default (no press).',
      );
      return { mode: entry.mode, written: false };
    }
    return { mode: entry.mode, written: true };
  } catch (err) {
    console.warn(
      `[fanout] could not give task workspace ${taskWorkspaceId} its owner's autonomy: ${String(err)}`,
    );
    return { mode: DEFAULT_MODE, written: false };
  }
}

// ── An owner's downgrade reaches its open tasks at once (C2 v2) ──────────────
//
// The inheritance above is a copy taken at fan-out. An owner switched from
// `danger` to `assist` or `off` afterwards used to leave every open worker at
// `danger`, with approval-press still on. So every autonomy write runs this:
// an open task whose mode ranks ABOVE its single owner's is lowered to the
// owner's mode. Downgrades only — raising the owner later does not hand press
// back to workers that were already started under a lower mode; a new fan-out
// inherits it. A task with several open owners is left alone (the daemon
// refuses automated approves there anyway: no single owner mode).
//
// The daemon also re-reads the owner's live mode on every automated approve
// (workspaceFactsFeed `ownerMode`), so this is the second of two guards, the
// one that also turns the task workspace's own readout down.

const MODE_RANK: Readonly<Record<AgentMode, number>> = { off: 0, assist: 1, danger: 2 };

interface OpenTaskRow {
  taskWorkspaceId: string;
  ownerWorkspaceId: string;
}

/** The (task, lower mode) writes a reconcile would make. Pure. */
export function planOwnerDowngrades(
  openTasks: readonly OpenTaskRow[],
  modeOf: (workspaceId: string) => AgentMode,
): Array<{ taskWorkspaceId: string; mode: AgentMode }> {
  const owners = new Map<string, Set<string>>();
  for (const t of openTasks) {
    const set = owners.get(t.taskWorkspaceId) ?? new Set<string>();
    set.add(t.ownerWorkspaceId);
    owners.set(t.taskWorkspaceId, set);
  }
  const out: Array<{ taskWorkspaceId: string; mode: AgentMode }> = [];
  for (const [taskWorkspaceId, set] of owners) {
    if (set.size !== 1) continue;
    const ownerMode = modeOf([...set][0] as string);
    if (MODE_RANK[modeOf(taskWorkspaceId)] > MODE_RANK[ownerMode]) {
      out.push({ taskWorkspaceId, mode: ownerMode });
    }
  }
  return out;
}

/**
 * Lower every open task workspace whose mode is above its owner's. Never
 * throws. Its own writes fire the autonomy listener again; that second pass
 * finds nothing to change, so it settles.
 */
export async function reconcileOwnerDowngrades(
  openTasks: () => readonly OpenTaskRow[],
  dir?: string,
): Promise<number> {
  let plan: Array<{ taskWorkspaceId: string; mode: AgentMode }>;
  try {
    plan = planOwnerDowngrades(openTasks(), (ws) => loadWorkspaceMode(ws, dir));
  } catch (err) {
    console.warn(`[fanout] could not read open tasks to propagate an owner downgrade: ${String(err)}`);
    return 0;
  }
  let written = 0;
  for (const { taskWorkspaceId, mode } of plan) {
    try {
      await setWorkspaceMode(taskWorkspaceId, mode, dir);
      written += 1;
      console.log(`[fanout] task workspace ${taskWorkspaceId} lowered to '${mode}' with its owner`);
    } catch (err) {
      console.warn(`[fanout] could not lower task workspace ${taskWorkspaceId} to '${mode}': ${String(err)}`);
    }
  }
  return written;
}
