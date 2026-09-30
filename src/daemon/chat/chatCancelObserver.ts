import {
  CHAT_CANCEL_OBSERVE_MS,
  type ChatCancelEndedAs, type ChatCancelEvidence, type ChatCancelOutcomeState, type StoredCancelProgress,
} from '../../shared/phoneChatCancelOutcome';
import type { ChatCancelReceiptStore } from './ChatCancelReceiptStore';
import type { ChatOwner } from './chatBridge';

/** Poll period while a cancel is `requested`. The phone polls the receipt every 2 s. */
export const CHAT_CANCEL_POLL_MS = 1000;

/** One cancel whose ESC was written, being watched until its outcome settles. */
export interface WatchedCancel {
  owner: ChatOwner;
  paneId: string;
  clientCancelId: string;
  /** The turn the ESC was aimed at, and when it started. */
  turnId: string;
  turnStartedAt: number;
  requestedAt: number;
}

/**
 * What one look at the pane found.
 * - `gone`: the pane closed or is another incarnation.
 * - `session-changed`: the pane now shows another conversation.
 * - `ended`: proof that the aimed turn ended.
 * - `running`: the aimed turn is still the pane's running turn.
 * - `idle`: the aimed turn is no longer running, but nothing proves how.
 */
export type CancelProbe =
  | { kind: 'gone' } | { kind: 'session-changed' } | { kind: 'running' } | { kind: 'idle' }
  | { kind: 'ended'; endedAs: ChatCancelEndedAs; evidence: ChatCancelEvidence };

/** SSE `chat.cancel`: narrower than the receipt (no evidence, reason or requestedAt). */
export interface ChatCancelEvent {
  owner: ChatOwner;
  sessionId: string;
  clientCancelId: string;
  state: ChatCancelOutcomeState;
  turnId?: string;
  endedAs?: ChatCancelEndedAs;
  at: number;
}

export interface ChatCancelObserverDeps<W extends WatchedCancel> {
  store: ChatCancelReceiptStore;
  probe(cancel: W): Promise<CancelProbe>;
  emit?(event: ChatCancelEvent): void;
  log?(message: string): void;
  now?: () => number;
  windowMs?: number;
  pollMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
}

export interface ChatCancelObserver<W extends WatchedCancel = WatchedCancel> {
  /** Record a progress change and announce it. False when the entry's progress is already final. */
  settle(cancel: Pick<WatchedCancel, 'owner' | 'paneId' | 'clientCancelId'> & { turnId?: string }, progress: StoredCancelProgress): boolean;
  /** Announce an entry's first progress (already stored with its outcome). */
  announce(cancel: Pick<WatchedCancel, 'owner' | 'paneId' | 'clientCancelId'> & { turnId?: string }, progress: StoredCancelProgress): void;
  /** Watch a `requested` cancel until it ends, or `CHAT_CANCEL_OBSERVE_MS` after the write. */
  watch(cancel: W): void;
}

/**
 * The Esc path's outcome (contract v-next item 3). `ended` needs proof; a turn
 * still running when the window closes is `not-ended`, and one that stopped
 * running without proof is `unknown`. Nothing survives a restart: a
 * `requested` entry then loads as `unknown` (`daemon-restart`).
 */
export function createChatCancelObserver<W extends WatchedCancel>(deps: ChatCancelObserverDeps<W>): ChatCancelObserver<W> {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? CHAT_CANCEL_OBSERVE_MS;
  const pollMs = deps.pollMs ?? CHAT_CANCEL_POLL_MS;
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });

  const announce: ChatCancelObserver<W>['announce'] = (cancel, progress) => {
    try {
      deps.emit?.({
        owner: cancel.owner, sessionId: cancel.paneId, clientCancelId: cancel.clientCancelId, state: progress.state,
        ...(cancel.turnId ? { turnId: cancel.turnId } : {}), ...(progress.endedAs ? { endedAs: progress.endedAs } : {}), at: progress.at,
      });
    } catch { /* a broken listener never stops the observation */ }
  };

  const settle: ChatCancelObserver<W>['settle'] = (cancel, progress) => {
    if (!deps.store.setProgress(cancel.owner, cancel.clientCancelId, progress)) return false;
    announce(cancel, progress);
    return true;
  };

  const watch = (cancel: W): void => {
    const deadline = cancel.requestedAt + windowMs;
    const tick = async (): Promise<void> => {
      const final = now() >= deadline;
      let seen: CancelProbe;
      try { seen = await deps.probe(cancel); } catch (error) {
        // No evidence either way: look again, or settle `unknown` at the deadline.
        deps.log?.(`[chat] cancel probe for ${cancel.paneId} failed: ${error instanceof Error ? error.message : String(error)}`);
        seen = { kind: 'idle' };
      }
      const at = now();
      switch (seen.kind) {
        case 'gone': settle(cancel, { state: 'unknown', reason: 'pane-closed', at }); return;
        case 'session-changed': settle(cancel, { state: 'unknown', reason: 'session-changed', at }); return;
        case 'ended': settle(cancel, { state: 'ended', endedAs: seen.endedAs, evidence: seen.evidence, at }); return;
        default:
          if (final) {
            settle(cancel, seen.kind === 'running' ? { state: 'not-ended', at } : { state: 'unknown', at });
            return;
          }
          schedule(() => void tick(), Math.min(pollMs, Math.max(0, deadline - at)));
      }
    };
    schedule(() => void tick(), Math.min(pollMs, windowMs));
  };

  return { settle, announce, watch };
}
