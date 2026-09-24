// Keeps `sidebarSeen` current: panes in view are "seen" as they change, new
// panes are seeded. Mounted once at the layout level so it runs while the
// sidebar is collapsed too (glance board, 2026-09-25).

import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores';
import { seenPanes, seenUpdates, visibleWorkspaceIds } from '../stores/selectors/sidebarSeen';

export function useSidebarSeenTracker(): void {
  // A compact key per pane plus the visible set: the effect re-runs only when
  // one of those changes, not on every store write.
  const key = useStore(useShallow((s) => {
    const out: Record<string, string> = {};
    for (const p of seenPanes(s)) out[p.ptyId] = `${p.workspaceId}|${p.stashed ? 1 : 0}|${p.entry.status}|${p.entry.question ?? ''}`;
    out['\u0000visible'] = [...visibleWorkspaceIds(s)].sort().join(',');
    return out;
  }));
  useEffect(() => {
    const s = useStore.getState();
    const updates = seenUpdates(seenPanes(s), visibleWorkspaceIds(s), s.sidebarSeen ?? {});
    if (Object.keys(updates).length > 0) s.markSidebarSeen(updates);
  }, [key]);
}

/** Render-null host for the tracker. */
export function SidebarSeenTracker(): null {
  useSidebarSeenTracker();
  return null;
}
