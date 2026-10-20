// ─── Conversation marks — what a bot's live conversation has taken in ──────
//
// A bot's engine conversation outlives its wakes: the runtime resumes it for
// the next one (BotRuntime session()), so text one turn read is still in
// context when a later, clean turn runs. Two marks follow the conversation,
// not the wake:
//
//   tainted      a wake run in it was started from outside text, or could
//                not be told clean (wakeTaint.ts wakeTainted)
//   readOutside  a call of it returned outside text (OUTSIDE_TEXT_RPC in
//                shared/botSurface.ts; RpcRouter marks it before the handler)
//
// The runtime starts a conversation's marks when it spawns one (clean when
// fresh, from the saved session record when resumed, both set for a guest's
// conversation of its own) and ends them when it ends the session. A mark is
// only ever set, never cleared, until the conversation starts afresh. A bot
// with no live conversation has no marks: a reader treats that as unknown.

export interface ConversationMarks {
  tainted: boolean;
  readOutside: boolean;
}

const marks = new Map<string, ConversationMarks>();
let listener: ((botId: string, marks: ConversationMarks) => void) | null = null;

/** A conversation starts (or is resumed) for `botId`. */
export function startConversation(botId: string, init: ConversationMarks): void {
  marks.set(botId, { tainted: init.tainted, readOutside: init.readOutside });
}

/** The bot's conversation ended. */
export function endConversation(botId: string): void {
  marks.delete(botId);
}

/** Set one mark on the bot's live conversation (none: nothing to mark). */
export function markConversation(botId: string, mark: keyof ConversationMarks): void {
  const m = marks.get(botId);
  if (!m || m[mark]) return;
  m[mark] = true;
  try {
    listener?.(botId, { ...m });
  } catch (err) {
    console.warn(`[factory] conversation mark of ${botId} not saved: ${String(err)}`);
  }
}

/** The bot's live conversation's marks, or null when it has none. */
export function conversationMarks(botId: string): ConversationMarks | null {
  const m = marks.get(botId);
  return m ? { ...m } : null;
}

/** Told when a mark is set (the runtime saves it with the session record). */
export function setConversationMarkListener(fn: ((botId: string, marks: ConversationMarks) => void) | null): void {
  listener = fn;
}

/** Test-only. */
export function __resetConversationMarksForTesting(): void {
  marks.clear();
  listener = null;
}
