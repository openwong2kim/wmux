// ─── LayoutLogicMounts — render-null components that host AppLayout's
//     store-subscribing logic hooks, isolated from the chrome (2026-07-13)
// ─────────────────────────────────────────────────────────────────────────────
//
// Some hooks AppLayout used to call directly subscribe to values that change on
// a workspace SWITCH — most importantly useActivePaneFocus, whose focusKey
// (useStore(computeFocusKey)) embeds activeWorkspaceId. A hook that re-renders
// re-renders its HOST component; hosted in AppLayout, that dragged the whole
// ~1300-line chrome through a re-render on every switch (measured: 12/12
// switches). Hosting the hook in a render-null child instead means the switch
// re-renders THIS tiny component, not the chrome.
//
// Behavior is identical — these hooks only run effects / add listeners; they
// render nothing. Their mount lifecycle matches AppLayout's (they mount/unmount
// with it since they live in its subtree).

import { useActivePaneFocus } from '../../hooks/useActivePaneFocus';

/**
 * Hosts useActivePaneFocus. Renders null. Its focusKey subscription
 * (activeWorkspaceId + active pane/surface/pty + multiview-grid flag) re-renders
 * THIS component on every workspace/pane/surface switch — deliberately kept out
 * of AppLayout so the chrome stays out of the switch re-render path.
 */
export function FocusManager() {
  useActivePaneFocus();
  return null;
}
