/**
 * Chat cancel outcome for the phone (docs/phone-client-contract.md,
 * "Proposed: contract v-next", item 3). CONTRACT ONLY: nothing serves it yet.
 *
 * Today's `POST …/chat/cancel` answers 202 `interrupt-requested` and stops
 * there. This adds what happened next, keyed by the same owner-bound
 * `clientCancelId`.
 */

/**
 * - `requested`: the interrupt was written (Esc, Codex `turn/interrupt`, or
 *   the OpenCode abort) and the aimed turn has not been seen to end yet.
 * - `ended`: the aimed turn was seen to end after the request.
 * - `not-ended`: the aimed turn was still running when the observation window
 *   closed. Nothing is retried; the user decides.
 * - `unknown`: the outcome cannot be known (the write itself was uncertain,
 *   the daemon restarted, the pane closed, or the conversation changed before
 *   an end was seen). Check Terminal.
 */
export type ChatCancelOutcomeState = 'requested' | 'ended' | 'not-ended' | 'unknown';

/** How the aimed turn ended, when the evidence says. */
export type ChatCancelEndedAs = 'interrupted' | 'completed' | 'failed' | 'unspecified';

/** What proved the end. `native`: the agent's own protocol reported it (Codex app-server, OpenCode plugin). */
export type ChatCancelEvidence = 'native' | 'transcript' | 'screen';

/** Why a cancel ended `unknown`. Open set. */
export type ChatCancelUnknownReason = 'write-uncertain' | 'daemon-restart' | 'pane-closed' | 'session-changed';

export interface ChatCancelProgress {
  state: ChatCancelOutcomeState;
  /** The turn the interrupt was aimed at (`t1:`). */
  turnId?: string;
  /** `ended` only. */
  endedAs?: ChatCancelEndedAs;
  /** `ended` only. */
  evidence?: ChatCancelEvidence;
  /** `unknown` only. */
  reason?: ChatCancelUnknownReason;
  /** Epoch ms the interrupt was written. */
  requestedAt?: number;
  /** Epoch ms the state last changed. */
  at: number;
}

/**
 * How long after the write the daemon keeps watching for the aimed turn to
 * end before settling `not-ended`. Claude's Esc lands within a frame; a turn
 * still running after this did not take the interrupt.
 */
export const CHAT_CANCEL_OBSERVE_MS = 15_000;

/** Final states never change again. */
export function isFinalCancelState(state: ChatCancelOutcomeState): boolean {
  return state !== 'requested';
}
