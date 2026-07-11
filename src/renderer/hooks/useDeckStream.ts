import { useEffect } from 'react';
import { useStore } from '../stores';

// ─── Command Deck Phase 2 — Commander brain stream bridge ────────────────────
//
// The SINGLE owner of the `deck.onStream` subscription. Mounted ONCE in
// AppLayout, always-on (NOT gated on the dock being visible): a brain turn keeps
// running in main even when the human switches away from the Commander tab, and
// its normalized events must still land in deckSlice so the transcript is
// complete when they switch back.
//
// The action is read via useStore.getState() so the effect deps stay [] — the
// subscription is established exactly once per renderer lifetime. Mirrors
// useRemoteInboxBridge / useApprovalInboxBridge.
export function useDeckStream(): void {
  useEffect(() => {
    const api = window.electronAPI.deck;
    if (!api) return; // older preload bundles may not expose this channel
    const off = api.onStream((event) => {
      useStore.getState().applyDeckBrainEvent(event);
    });
    return off;
  }, []);
}
