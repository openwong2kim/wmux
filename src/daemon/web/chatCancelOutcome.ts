import type { ChatBridge, ChatOwner } from '../chat/chatBridge';
import type { ChatCancelEvent } from '../chat/chatCancelObserver';

/**
 * Wire shapes for the chat cancel outcome (docs/phone-client-contract.md,
 * "Chat cancel outcome"). The web server only gates and routes; the bodies
 * are built here.
 */

/**
 * `GET /api/sessions/:id/chat/cancel/:clientCancelId`, after the transcript
 * and pane gates. Owner- and pane-bound: another device's cancel, another
 * pane's, a refused one and an unknown id all read `none`. No store: the
 * POST's own unavailable tag.
 */
export function cancelReceiptResponse(
  chat: Pick<ChatBridge, 'cancelOutcome'> | null,
  owner: ChatOwner,
  id: string,
  clientCancelId: string,
): { status: number; body: Record<string, unknown> } {
  const progress = chat?.cancelOutcome?.(owner, id, clientCancelId);
  if (progress === null || progress === undefined && !chat?.cancelOutcome) return { status: 503, body: { error: 'chat-persist-failed' } };
  return { status: 200, body: progress ? { clientCancelId, ...progress } : { clientCancelId, state: 'none' } };
}

/** SSE `chat.cancel` body: `{sessionId, clientCancelId, state, turnId?, endedAs?, at}`. */
export function cancelEventBody(event: ChatCancelEvent): string {
  return JSON.stringify({
    sessionId: event.sessionId, clientCancelId: event.clientCancelId, state: event.state,
    ...(event.turnId ? { turnId: event.turnId } : {}), ...(event.endedAs ? { endedAs: event.endedAs } : {}), at: event.at,
  });
}
