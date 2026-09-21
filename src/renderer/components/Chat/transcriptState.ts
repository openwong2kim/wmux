import type { TurnEvent } from '../../../shared/transcript/turnEvents';

/** Stable transcript ids replace repeated tail rows; pagination never duplicates
 * a message already received through the live subscription. */
export function mergeTranscriptEvents(current: readonly TurnEvent[], incoming: readonly TurnEvent[], prepend = false): TurnEvent[] {
  const updated = new Map(incoming.map((event) => [event.id, event]));
  const existing = new Set(current.map((event) => event.id));
  const fresh = incoming.filter((event) => !existing.has(event.id));
  const retained = current.map((event) => updated.get(event.id) ?? event);
  return prepend ? [...fresh, ...retained] : [...retained, ...fresh];
}
