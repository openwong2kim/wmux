/**
 * Chat cancel outcome for the phone (docs/phone-client-contract.md, "Chat
 * cancel outcome"). Served for the Esc path (Claude, Codex) and for Codex
 * `turn/interrupt` on relay panes (`native` evidence); the OpenCode plugin's
 * `native` evidence is not served yet.
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
  /**
   * `ended` only, Claude only, and only when the daemon itself sent the aimed
   * turn's text. Claude puts a prompt interrupted before any output back into
   * its input box, which then refuses every send (`input-not-provably-empty`).
   * `true`: once the turn ended, the input box held exactly that text.
   * `false`: it was read and did not (empty, or other text). Absent: not checked
   * (no daemon-sent text for the turn, the screen unreadable, a dialog up, or
   * another send in flight).
   */
  promptRestored?: boolean;
  /**
   * Present only with `promptRestored: true`. `true`: the daemon cleared the
   * restored text (Ctrl-U, which Claude can undo with Ctrl-Y) and a re-read
   * showed the input box empty. `false`: it is not proven empty; check Terminal.
   */
  inputCleared?: boolean;
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
  promptRestored?: boolean;
  inputCleared?: boolean;
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
  // A stored value is untrusted file content: normalize it, never pass it through.
  // No outcome yet means the write is still in flight (`pending`): `requested`
  // while this daemon runs, `unknown` (`daemon-restart`) once it restarted.
  const stored = entry.progress !== undefined
    ? normalizeCancelProgress(entry.progress, entry.createdAt)
    : entry.outcome?.effect === 'uncertain'
      ? { state: 'unknown' as const, reason: 'write-uncertain' as const, at: entry.createdAt }
      : { state: 'requested' as const, at: entry.createdAt };
  if (restarted && stored.state === 'requested') return { state: 'unknown', reason: 'daemon-restart', at: now };
  return stored;
}

const STATES: ReadonlySet<string> = new Set<ChatCancelOutcomeState>(['requested', 'ended', 'not-ended', 'unknown']);
const ENDED_AS: ReadonlySet<string> = new Set<ChatCancelEndedAs>(['interrupted', 'completed', 'failed', 'unspecified']);
const EVIDENCE: ReadonlySet<string> = new Set<ChatCancelEvidence>(['native', 'transcript', 'screen']);
const REASON = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A stored or received progress value, checked field by field. A state
 * outside the union reads `unknown`; fields that do not belong to the state,
 * or fail their check, are dropped.
 */
export function normalizeCancelProgress(value: unknown, fallbackAt: number): StoredCancelProgress {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const at = typeof v.at === 'number' && Number.isSafeInteger(v.at) && v.at > 0 ? v.at : fallbackAt;
  const state = typeof v.state === 'string' && STATES.has(v.state) ? v.state as ChatCancelOutcomeState : 'unknown';
  if (state === 'ended') {
    return { state, at,
      ...(typeof v.endedAs === 'string' && ENDED_AS.has(v.endedAs) ? { endedAs: v.endedAs as ChatCancelEndedAs } : {}),
      ...(typeof v.evidence === 'string' && EVIDENCE.has(v.evidence) ? { evidence: v.evidence as ChatCancelEvidence } : {}),
      ...(typeof v.promptRestored === 'boolean' ? { promptRestored: v.promptRestored } : {}),
      ...(v.promptRestored === true && typeof v.inputCleared === 'boolean' ? { inputCleared: v.inputCleared } : {}) };
  }
  if (state === 'unknown') {
    return { state, at, ...(typeof v.reason === 'string' && REASON.test(v.reason) ? { reason: v.reason as ChatCancelUnknownReason } : {}) };
  }
  return { state, at };
}

/** `GET /api/sessions/<id>/chat/cancel/<clientCancelId>` 200 body. */
export interface ChatCancelReceiptView {
  clientCancelId: string;
  state: ChatCancelOutcomeState | 'none';
  turnId?: string;
  endedAs?: ChatCancelEndedAs;
  evidence?: ChatCancelEvidence;
  reason?: ChatCancelUnknownReason;
  promptRestored?: boolean;
  inputCleared?: boolean;
  requestedAt?: number;
  at?: number;
}

/**
 * `chat.cancel` SSE frame. It carries no `evidence`/`reason`: on a final
 * `state`, read the receipt when those matter.
 */
export interface ChatCancelEventFrame {
  sessionId: string;
  clientCancelId: string;
  state: ChatCancelOutcomeState;
  turnId?: string;
  endedAs?: ChatCancelEndedAs;
  at: number;
}
