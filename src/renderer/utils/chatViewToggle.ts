// The Terminal↔Chat flip for the FOCUSED pane's active surface.
//
// Two entry points reach for it — the ⇧⌘J chord and the command palette — and
// both have to apply the same gate, so the rule lives here once: a non-terminal
// surface has nothing to project, entering Chat needs a live projection, and
// leaving Chat is always allowed. The per-surface right-click (SurfaceTabs)
// addresses a NAMED surface, including one in an unfocused pane, so it keeps
// its own path.

import { useStore } from '../stores';
import { findLeaf } from '../../shared/paneUtils';

export function toggleActiveSurfaceChatMode(): void {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;
  const leaf = findLeaf(ws.rootPane, ws.activePaneId);
  if (!leaf) return;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  if (!surface || !surface.ptyId) return;
  if (surface.surfaceType && surface.surfaceType !== 'terminal') return;
  if (surface.chatMode) {
    state.setSurfaceChatMode(surface.id, false);
  } else if (state.chatStatus[surface.ptyId]?.available) {
    state.setSurfaceChatMode(surface.id, true);
  }
}
