// Keeps `sidebarSeen` current: tabs in view are marked seen as they change,
// new tabs are seeded, closed tabs are pruned. Mounted once at the layout
// level (as a render-null component) so it runs while the sidebar is collapsed
// too (glance board, 2026-09-25).

import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores';
import { seenTabs, seenUpdates, surfacePtyIds, visibleWorkspaceIds } from '../stores/selectors/sidebarSeen';

export function useSidebarSeenTracker(): void {
  // A compact key per tab plus the visible set: the effect re-runs only when
  // one of those changes. seenTabs is cached per store state.
  const key = useStore(useShallow((s) => {
    const out: Record<string, string> = {};
    for (const t of seenTabs(s)) out[t.ptyId] = `${t.workspaceId}|${t.stashed ? 1 : 0}|${t.entry.status}|${t.entry.question ?? ''}`;
    out['\u0000visible'] = [...visibleWorkspaceIds(s)].sort().join(',');
    return out;
  }));
  useEffect(() => {
    const s = useStore.getState();
    const { updates, removed } = seenUpdates(seenTabs(s), visibleWorkspaceIds(s), s.sidebarSeen ?? {}, surfacePtyIds(s));
    if (Object.keys(updates).length > 0 || removed.length > 0) s.markSidebarSeen(updates, removed);
  }, [key]);
}

/** Render-null host for the tracker. */
export function SidebarSeenTracker(): null {
  useSidebarSeenTracker();
  return null;
}
