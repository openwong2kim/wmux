// The deck header's trailing slot, for controls owned by the view below it.
//
// The header (DeckTabs) and the view (CommanderView) are siblings in the dock,
// and the Moa panel's options menu needs the view's state (its brain, its
// chat/terminal view, its loop and schedules) while it sits in the header row.
// DeckTabs registers the slot element here; CommanderView portals into it.
import { useSyncExternalStore } from 'react';

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Ref callback for the header's slot element (null on unmount). */
export function setDeckHeaderSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The mounted header slot, or null when no header offers one. */
export function useDeckHeaderSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
