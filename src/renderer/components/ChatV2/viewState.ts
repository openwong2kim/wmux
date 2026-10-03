/**
 * The renderer side of the chat-v2 snapshot/push contract (ipc.ts header), as
 * pure functions: a view holds the session head plus a tail window of blocks,
 * folds pushed events with the shared fold, and asks for a fresh snapshot when
 * the contract's rules say its copy can no longer be trusted.
 */
import { applyHarnessEvents } from '../../../shared/chatv2/apply';
import type { ChatV2Binding, ChatV2EventsPush, ChatV2HistoryPage, ChatV2Snapshot } from '../../../shared/chatv2/ipc';
import { CHATV2_ANSWER_ARM_MS } from '../../../shared/chatv2/limits';
import type { Session } from '../../../shared/chatv2/session';

export interface ChatV2ViewState {
  binding: ChatV2Binding;
  /** Head plus the loaded window of blocks (`session.blocks[0]` is transcript index `baseIndex`). */
  session: Session;
  baseIndex: number;
  /** The last seq folded into `session`. */
  lastSeq: number;
  epoch: string;
}

export function stateFromSnapshot(snapshot: ChatV2Snapshot): ChatV2ViewState {
  return {
    binding: snapshot.binding,
    session: { ...snapshot.head, blocks: snapshot.blocks },
    baseIndex: snapshot.baseIndex,
    lastSeq: snapshot.binding.seq,
    epoch: snapshot.binding.epoch,
  };
}

export const RESNAPSHOT = 'resnapshot' as const;

/**
 * Apply one push. Returns the same state when every event was already folded,
 * the next state when the push continues this copy, or `RESNAPSHOT` when the
 * epoch changed, a seq is missing, the push touched a block below the window,
 * or the fold disagrees with the daemon's block count or last block id.
 */
export function applyPushToView(state: ChatV2ViewState, push: ChatV2EventsPush): ChatV2ViewState | typeof RESNAPSHOT {
  if (push.epoch !== state.epoch || push.chatSessionId !== state.binding.chatSessionId) return RESNAPSHOT;
  const fresh = push.events.filter((event) => event.seq > state.lastSeq);
  if (!fresh.length) return state;
  if (fresh[0].seq !== state.lastSeq + 1) return RESNAPSHOT;
  if (push.touchedFrom < state.baseIndex) return RESNAPSHOT;
  const session = applyHarnessEvents(state.session, fresh);
  const lastBlock = session.blocks[session.blocks.length - 1];
  if (state.baseIndex + session.blocks.length !== push.blockCount) return RESNAPSHOT;
  if ((lastBlock?.id ?? null) !== push.lastBlockId) return RESNAPSHOT;
  const lastSeq = fresh[fresh.length - 1].seq;
  const binding = push.binding ?? state.binding;
  return { ...state, session, lastSeq, binding: { ...binding, seq: Math.max(binding.seq, lastSeq) } };
}

/** Prepend an older page. Null when it does not line up with the window (re-snapshot). */
export function prependHistory(state: ChatV2ViewState, page: ChatV2HistoryPage): ChatV2ViewState | null {
  if (page.epoch !== state.epoch) return null;
  if (page.baseIndex + page.blocks.length !== state.baseIndex) return null;
  return { ...state, baseIndex: page.baseIndex, session: { ...state.session, blocks: [...page.blocks, ...state.session.blocks] } };
}

/** Buttons on an approval or question card answer from this time (the registry rule). */
export function answerArmedAt(requestedAt: number): number {
  return requestedAt + CHATV2_ANSWER_ARM_MS;
}

/** Which view a terminal surface shows (contract: View selection). */
export type ChatSurfaceView = 'terminal' | 'projection' | 'chatv2';

export function selectChatSurfaceView(input: {
  chatViewEnabled: boolean;
  viewMode: 'terminal' | 'chat' | undefined;
  /**
   * The pane's chat-v2 record: a binding, null (none), false (no chat-v2 host
   * answered) or undefined (not known yet).
   */
  binding: ChatV2Binding | null | false | undefined;
  /** A TUI agent is tracked alive in the pane. */
  agentRunning: boolean;
}): ChatSurfaceView {
  if (!input.chatViewEnabled || input.viewMode !== 'chat') return 'terminal';
  if (input.binding) return 'chatv2';
  // The empty chat-v2 composer only for a free pane whose host said "no record";
  // until then, and without a host, the terminal-projection chat stays.
  return input.binding === null && !input.agentRunning ? 'chatv2' : 'projection';
}
