import { useEffect } from 'react';
import { useStore } from '../stores';

// ─── browser_request_help bridge ─────────────────────────────────────────────
//
// The SINGLE owner of the `browserHelp.onOpen` + `browserHelp.onClosed`
// subscription, mounted ONCE in AppLayout and always-on — not gated on the
// browser pane being mounted or the Fleet cockpit being open, so a request
// reaches the store no matter which surface the operator is looking at.
//
// It deliberately does NOT jump. Bringing the surface's pane into view is
// main's job (the RPC handler sends `surface.focus`, which activates the owning
// workspace's pane and surface without touching `activeWorkspaceId`). Calling
// the renderer's `focusNotificationTarget` here instead would be wrong twice
// over: it switches the operator's active workspace, and it auto-unstashes the
// target pane — a behaviour `useNotificationListener` documents as right "here
// and only here: the user clicked… An RPC caller gets a PANE_STASHED refusal
// instead — an agent rearranging the layout as a side effect IS the surprise
// this feature exists to prevent." This event is an agent's, not a click's. The
// operator-initiated jump lives on the Fleet inbox row, where a human presses it.
//
// Actions are read via useStore.getState() so the effect deps stay [] — the
// subscription is established exactly once per renderer lifetime.
export function useBrowserHelpBridge(): void {
  useEffect(() => {
    const api = window.electronAPI.browserHelp;
    if (!api) return; // older preload bundles do not expose this channel

    const offOpen = api.onOpen((info) => {
      useStore.getState().addBrowserHelpRequest(info);
    });
    const offClosed = api.onClosed(({ requestId }) => {
      useStore.getState().removeBrowserHelpRequest(requestId);
    });

    return () => {
      offOpen();
      offClosed();
    };
  }, []);
}
