import type { TurnEvent } from '../../../../shared/transcript/turnEvents';
import type { DeckBrainMessage } from '../../Deck/deckBrain';

/** Local Fleet answers were never sent to Claude. Merge only explicitly marked
 * exchanges; ordinary stream text must still come from the real transcript. */
export function mergeLocalFleetEvents(events: readonly TurnEvent[], messages: readonly DeckBrainMessage[], label?: string): TurnEvent[] {
  const local = messages.filter((m) => m.localFleet && (m.role === 'user' || (m.role === 'assistant' && m.status === 'done')))
    .slice(-100).map((m): TurnEvent => m.role === 'user'
      ? { id: `local-fleet:${m.id}`, kind: 'user_text', text: m.text, ts: m.ts }
      // Labelled: this answer came from the local Fleet board, not from Moa.
      : { id: `local-fleet:${m.id}`, kind: 'assistant_text', text: label ? `*${label}*\n\n${m.text}` : m.text, ts: m.ts, turnComplete: true });
  if (local.length === 0) return [...events];
  const ids = new Set(events.map((e) => e.id));
  const pending = local.filter((e) => !ids.has(e.id)).sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
  const merged: TurnEvent[] = [];
  // A native transcript's source order is authoritative, including untimed
  // tool rows. Insert local rows at known time anchors without sorting it.
  for (const event of events) {
    while (pending.length && event.ts !== undefined && pending[0].ts !== undefined && pending[0].ts < event.ts) {
      merged.push(pending.shift() as TurnEvent);
    }
    merged.push(event);
  }
  return [...merged, ...pending];
}
