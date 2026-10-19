// ─── Work a conversation handed off, folded into one card (pure) ─────────
//
// Owner decision 2026-10-16: a thread a conversation started (a
// coordinator's request thread, opened from its 1:1 or a group chat;
// botsModel.ts dmStartedThreads / groupStartedThreads) shows in that
// conversation as one work card at the position of its root, instead of the
// thread's own cards: who it was handed to, the request, the delegate's
// newest message, its state, and the steps folded inside. A card that waits
// on the owner still shows in the timeline too; the side panel still shows
// the whole thread. This module reads the cards the card is built from;
// botsTimeline.ts places it and BotsWorkCard.tsx draws it.
import type { RoomCard, ThreadSummary } from '../../../shared/room';
import { startedThreadsOf } from '../../../shared/botsWork';
import type { Conversation } from './botsModel';

export {
  isPointerCard, workDelegate, workLatest, workRef, workState, workTitle, workView,
  type WorkState, type WorkThread, type WorkView,
} from '../../../shared/botsWork';

type ThreadsByWorkspace = Readonly<Record<string, readonly ThreadSummary[] | undefined>>;

/** The thread keys (`workspaceId\0threadId`, botsTimeline threadKey) of the
 *  threads this conversation started. Pure. */
export function conversationStartedThreads(conversation: Conversation, cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): Set<string> {
  return startedThreadsOf(conversation.kind === 'bot' ? { botId: conversation.row.bot.id } : { threadId: conversation.threadId }, cards, threads);
}
