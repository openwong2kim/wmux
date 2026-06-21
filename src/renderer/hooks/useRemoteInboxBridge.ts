import { useEffect } from 'react';
import { useStore } from '../stores';

// ─── LanLink PR-2 Remote Inbox bridge ────────────────────────────────────────
//
// The SINGLE owner of the `lanlink.onRemote` subscription. Mounted ONCE in
// AppLayout, always-on (NOT gated on any view), so remote peer messages
// accumulate in the store regardless of which surface is visible.
//
// The action is read via useStore.getState() rather than a selector
// subscription so the effect deps stay [] — the subscription is established
// exactly once per renderer lifetime and torn down on unmount. Mirrors
// useApprovalInboxBridge.
export function useRemoteInboxBridge(): void {
  useEffect(() => {
    const api = window.electronAPI.lanlink;
    if (!api) return; // older preload bundles may not expose this channel
    const off = api.onRemote((item) => {
      useStore.getState().addRemoteItem(item);
    });
    // Request a full replay AFTER the listener is installed. Re-materializes the
    // inbox on a renderer reload (store wiped while main + cursor survive) and on
    // cold start (main may have pulled before this listener existed). Idempotent
    // — the slice's isNew guard dedups any overlap.
    api.requestResync?.();
    return off;
  }, []);
}
