import { useEffect } from 'react';
import { useStore } from '../stores';

// ─── Command Deck Phase 2 — Commander brain stream bridge ────────────────────
//
// The SINGLE owner of the `deck.onStream` subscription. Mounted ONCE in
// AppLayout, always-on (NOT gated on the dock being visible): a brain turn
// keeps running in main even when the human switches away from the Commander
// tab — or to ANOTHER WORKSPACE (M1.5: one orchestrator per workspace) — and
// its normalized events must still land in the right workspace's thread in
// deckSlice so the transcript is complete when they switch back. Events
// arrive enveloped with the workspaceId of the orchestrator that produced
// them; the envelope, not the active workspace, decides the target thread.
//
// The action is read via useStore.getState() so the effect deps stay [] — the
// subscription is established exactly once per renderer lifetime. Mirrors
// useRemoteInboxBridge / useApprovalInboxBridge.
export function useDeckStream(): void {
  useEffect(() => {
    const api = window.electronAPI.deck;
    if (!api) return; // older preload bundles may not expose this channel
    const off = api.onStream(({ workspaceId, event }) => {
      if (!workspaceId) return; // malformed envelope — never guess a thread
      useStore.getState().applyDeckBrainEvent(workspaceId, event);
    });
    // `claude-pty` brain: the pty id of the embedded TUI. Subscribed here, in
    // the same always-on owner, so a brain that spawns while the human is on
    // another workspace still has its terminal ready when they switch back.
    const offPty = api.onBrainPty?.(({ workspaceId, ptyId }) => {
      if (!workspaceId) return;
      useStore.getState().setBrainPtyId(workspaceId, ptyId ?? null);
    });
    // …and hydrate from main's snapshot, because every push that landed
    // before this subscription existed (app start, a renderer reload) is
    // simply gone. Main is the authority; a failed call just leaves the deck
    // on the bubble view until the next spawn pushes.
    let cancelled = false;
    void api.listBrainPtys?.().then((res) => {
      if (cancelled || !res?.ptyIds) return;
      useStore.getState().hydrateBrainPtyIds(res.ptyIds);
    }).catch(() => {
      /* older main without the hydration channel */
    });
    return () => {
      cancelled = true;
      off();
      offPty?.();
    };
  }, []);
}
