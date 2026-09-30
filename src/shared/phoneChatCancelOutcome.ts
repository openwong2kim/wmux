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

/**
 * Final states never change again. `not-ended` included: a turn that ends
 * after the observation window does not revise it (the client re-reads
 * `/turns` for the turn's current state).
 */
export function isFinalCancelState(state: ChatCancelOutcomeState): boolean {
  return state !== 'requested';
}

/**
 * What `chat-cancel-receipts.json` (still `version: 1`) stores next to an
 * entry's `outcome`, as an optional `progress` field. `outcome.effect` keeps
 * its two values; an older daemon ignores this field.
 */
export interface StoredCancelProgress {
  state: ChatCancelOutcomeState;
  endedAs?: ChatCancelEndedAs;
  evidence?: ChatCancelEvidence;
  reason?: ChatCancelUnknownReason;
  at: number;
}

/**
 * Progress for an entry, reading a missing `progress` from the effect the
 * entry already stores. `restarted` is true when the entry is being loaded
 * after a daemon restart: nothing is observing it any more, so a `requested`
 * progress settles `unknown` (`daemon-restart`), in the same write that turns
 * a `pending` entry into a final `uncertain` one.
 */
export function effectiveCancelProgress(
  entry: { outcome?: { effect: 'interrupt-requested' | 'uncertain' }; progress?: StoredCancelProgress; createdAt: number },
  restarted: boolean,
  now: number,
): StoredCancelProgress {
  const stored = entry.progress
    ?? (entry.outcome?.effect === 'interrupt-requested'
      ? { state: 'requested' as const, at: entry.createdAt }
      : { state: 'unknown' as const, reason: entry.outcome ? 'write-uncertain' as const : 'daemon-restart' as const, at: entry.createdAt });
  if (restarted && stored.state === 'requested') return { state: 'unknown', reason: 'daemon-restart', at: now };
  return stored;
}
