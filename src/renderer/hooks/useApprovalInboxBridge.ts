import { useEffect } from 'react';
import { useStore } from '../stores';

// ─── S-C2 Approval Inbox bridge ──────────────────────────────────────────────
//
// The SINGLE owner of the `permissionPrompt.onOpen` + `permissionPrompt.onClosed`
// subscription (non-negotiable guard #2: exactly one onOpen consumer). Mounted
// ONCE in AppLayout, always-on — NOT gated on fleetViewVisible — so MCP prompts
// accumulate in the store before the cockpit's Approvals tab is ever opened.
//
// onOpen → addMcpPrompt; onClosed → removeMcpPrompt. The closed-push is the
// authoritative cross-surface removal that pairs with the optimistic local
// removal in resolveInboxItem (both idempotent, so a double-fire is harmless).
//
// Actions are read via useStore.getState() rather than selector subscriptions so
// the effect deps stay [] — the subscription is established exactly once per
// renderer lifetime and torn down on unmount.
export function useApprovalInboxBridge(): void {
  useEffect(() => {
    const api = window.electronAPI.permissionPrompt;
    if (!api) return; // older preload bundles may not expose this channel

    const offOpen = api.onOpen((info) => {
      useStore.getState().addMcpPrompt(info);
    });
    const offClosed = api.onClosed(({ promptId }) => {
      useStore.getState().removeMcpPrompt(promptId);
    });

    return () => {
      offOpen();
      offClosed();
    };
  }, []);
}
