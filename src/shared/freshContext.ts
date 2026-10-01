// ─── Fresh context per dispatched task (#1680) ───────────────────────────────
//
// A long-lived worker pane carries one task's conversation into the next. A
// role can ask for a fresh conversation at the start of each dispatched task:
// wmux types the bound agent's fresh-context command (`/clear` for Claude Code,
// `/new` for Codex — agentLaunchOptions) before it delivers the task text.
//
// Two keys, both required:
//  - the CALLER declares the task boundary: `input.send` `newTask: true`
//    (MCP `terminal_send` `new_task`), or the new-task branch of an a2a send.
//    A reply or a status update never is one.
//  - the OPERATOR opted in: the pane's role binding has `freshContext: true`
//    and names an agent with a verified command (bindingEnforcesFreshContext).
// So an agent cannot clear a pane whose operator did not opt in, and an
// opted-in pane is never cleared on an ordinary message.
//
// Shared by main (the engine), the renderer (a2a delivery receipts) and the MCP
// server (client timeouts), which is compiled for ES2020 — keep this file free
// of newer APIs.

/**
 * What happened to a new-task send's fresh-context step.
 *  - `applied`: the command ran and finished; the text went to a fresh
 *    conversation.
 *  - `skipped_busy`: the agent was working, the composer held someone's draft,
 *    other input arrived while the command was typed, or (a2a) the pane still
 *    has other open tasks. The text was delivered WITHOUT clearing.
 *  - `skipped_mismatch`: the agent running in the pane is not the role's bound
 *    agent. Delivered without clearing.
 *  - `skipped_unobservable`: wmux could not see the pane well enough to type
 *    into it safely (no daemon state, unreadable screen). Delivered without
 *    clearing.
 *  - `not_bound`: the pane's role does not ask for fresh context (or its agent
 *    has no verified command). Delivered as usual.
 * A command that was typed but never seen to finish is not a result: the send
 * fails and the text is not delivered (see FRESH_CONTEXT_TIMEOUT_MS).
 */
export type FreshContextResult =
  | 'applied'
  | 'skipped_busy'
  | 'skipped_mismatch'
  | 'skipped_unobservable'
  | 'not_bound';

/** Which evidence said the command finished. */
export type FreshContextSignal = 'session_start' | 'screen';

/** The reply fields a new-task send carries (experimental, see docs/api). */
export interface FreshContextReply {
  freshContext: FreshContextResult;
  /** The command typed, present when it ran (`applied`). */
  freshContextCommand?: string;
  /** The evidence that it finished, present with `applied`. */
  freshContextSignal?: FreshContextSignal;
  /** Why it was skipped, or which evidence it waited for. Wording not stable;
   *  starts with a short code (`agent_busy`, `draft_in_composer`, …). */
  freshContextReason?: string;
}

/**
 * How long wmux waits, after the command's Enter, for evidence that it
 * finished. Past this the send fails and the task text is NOT written: the
 * pane may still be clearing, and text typed into it now could land in the
 * old conversation or be lost. Owner decision 2026-10-01: 8 s, adjustable
 * after live measurement.
 */
export const FRESH_CONTEXT_TIMEOUT_MS = 8_000;

/** Poll interval while waiting for that evidence. */
export const FRESH_CONTEXT_POLL_MS = 100;

/** Two identical screen reads at least this far apart count as settled. */
export const FRESH_CONTEXT_SETTLE_MS = 300;

/**
 * How much longer a pane whose agent's hooks report SessionStart is given for
 * that hook, once the screen already shows the command finished. Past it the
 * screen is accepted (`freshContextSignal: 'screen'`, reason
 * `session_start_missing`): a pane whose current agent runs without the hooks
 * (another config dir, hooks removed) must not wait forever on a receipt left
 * by an earlier run.
 */
export const FRESH_CONTEXT_HOOK_GRACE_MS = 2_500;

/**
 * How long the screen must hold unchanged when it looks the same as before the
 * command (an already-empty conversation, e.g. a just-launched agent) before
 * that counts as finished (reason `screen_unchanged`). A screen that changed
 * needs only FRESH_CONTEXT_SETTLE_MS.
 */
export const FRESH_CONTEXT_UNCHANGED_HOLD_MS = 3_000;

/**
 * How long a new-task send waits for another new-task send to the same pane to
 * finish before it gives up with nothing written. Well under the callers'
 * budgets below, so a queued send never outlives its caller and then delivers
 * behind a retry.
 */
export const FRESH_CONTEXT_LOCK_WAIT_MS = 4_000;

/**
 * Main's renderer budget for an a2a new-task send. The renderer's delivery can
 * now include a fresh-context step (up to FRESH_CONTEXT_TIMEOUT_MS after the
 * command, plus the reads before it and the paste after it), which the 5 s
 * bridge default would cut off mid-clear. Worst case with every read at its
 * own timeout: lock wait 4 s + task-store read 2 s + gates + echo 1.5 s + wait
 * about 9 s + paste — about 21 s, so 25 s leaves headroom; a renderer that
 * outlives main's wait would still deliver after main gave up, and a retry
 * would then send the task twice.
 */
export const NEW_TASK_SEND_MAIN_TIMEOUT_MS = 25_000;

/** The MCP client's budget for a new-task `send_message`: outwaits main. */
export const NEW_TASK_SEND_CLIENT_TIMEOUT_MS = 30_000;

/** The MCP client's budget for `terminal_send` with `new_task`: the fresh
 *  context step plus the ordinary submit receipt. */
export const TERMINAL_SEND_NEW_TASK_TIMEOUT_MS = 25_000;
