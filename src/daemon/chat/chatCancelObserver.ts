import {
  CHAT_CANCEL_OBSERVE_MS,
  type ChatCancelEndedAs, type ChatCancelEventFrame, type ChatCancelEvidence, type StoredCancelProgress,
} from '../../shared/phoneChatCancelOutcome';
import type { ChatCancelReceiptStore } from './ChatCancelReceiptStore';
import type { ChatOwner } from './chatBridge';

/** Poll period while a cancel is `requested`. The phone polls the receipt every 2 s. */
export const CHAT_CANCEL_POLL_MS = 1000;
/** Failed progress writes retried after the window closes, one per poll. */
const LATE_SAVE_RETRIES = 5;

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
 * - `unprovable`: the transcript moved past the aimed turn without a
 *   provable end (a new turn started first, or the tail lost the boundary).
 * - `transient`: the pane is the same incarnation but not attached or
 *   detached right now; look again.
 */
export type CancelProbe =
  | { kind: 'gone' } | { kind: 'session-changed' } | { kind: 'running' } | { kind: 'idle' }
  | { kind: 'unprovable' } | { kind: 'transient' }
  | { kind: 'ended'; endedAs: ChatCancelEndedAs; evidence: ChatCancelEvidence;
    /** The end is proven but a check on it is not done yet: settle only at the deadline. */
    pending?: true;
    /** Screen evidence was Claude's Stop-hook row: the turn completed rather than took the interrupt. */
    stopHook?: true;
  } & Pick<StoredCancelProgress, 'promptRestored' | 'inputCleared' | 'restoredMessageId'>;

/** SSE `chat.cancel` (`ChatCancelEventFrame`), plus the owner it is delivered to. */
export interface ChatCancelEvent extends ChatCancelEventFrame {
  owner: ChatOwner;
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
  /**
   * Record a progress change and, once it is on disk, announce it. `unsaved`:
   * nothing changed (the caller may retry); `final`: already settled.
   */
  settle(cancel: Pick<WatchedCancel, 'owner' | 'paneId' | 'clientCancelId'> & { turnId?: string }, progress: StoredCancelProgress): 'saved' | 'unsaved' | 'final';
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
    const result = deps.store.setProgress(cancel.owner, cancel.clientCancelId, progress);
    if (result === 'saved') announce(cancel, progress);
    else if (result === 'unsaved') deps.log?.(`[chat] cancel progress for ${cancel.paneId} not persisted; retrying`);
    return result;
  };

  const watch = (cancel: W): void => {
    const deadline = cancel.requestedAt + windowMs;
    let lateTries = 0;
    const tick = async (): Promise<void> => {
      const final = now() >= deadline;
      if (final && lateTries++ > LATE_SAVE_RETRIES) return;
      let seen: CancelProbe;
      try { seen = await deps.probe(cancel); } catch (error) {
        // No evidence either way: look again, or settle `unknown` at the deadline.
        deps.log?.(`[chat] cancel probe for ${cancel.paneId} failed: ${error instanceof Error ? error.message : String(error)}`);
        seen = { kind: 'idle' };
      }
      const at = now();
      let progress: StoredCancelProgress | undefined;
      switch (seen.kind) {
        case 'gone': progress = { state: 'unknown', reason: 'pane-closed', at }; break;
        case 'session-changed': progress = { state: 'unknown', reason: 'session-changed', at }; break;
        case 'ended':
          if (seen.pending && !final) break;
          progress = { state: 'ended', endedAs: seen.endedAs, evidence: seen.evidence,
            ...(seen.promptRestored !== undefined ? { promptRestored: seen.promptRestored } : {}),
            ...(seen.inputCleared !== undefined ? { inputCleared: seen.inputCleared } : {}),
            ...(seen.restoredMessageId !== undefined ? { restoredMessageId: seen.restoredMessageId } : {}), at };
          break;
        case 'unprovable': progress = { state: 'unknown', at }; break;
        default:
          if (final) {
            progress = seen.kind === 'running' ? { state: 'not-ended', at }
              : seen.kind === 'transient' ? { state: 'unknown', reason: 'pane-closed', at } : { state: 'unknown', at };
          }
      }
      // Settled, or already final: done. Unsaved or undecided: look again.
      if (progress && settle(cancel, progress) !== 'unsaved') return;
      schedule(() => void tick(), final ? pollMs : Math.min(pollMs, Math.max(0, deadline - at)));
    };
    schedule(() => void tick(), Math.min(pollMs, windowMs));
  };

  return { settle, announce, watch };
}
