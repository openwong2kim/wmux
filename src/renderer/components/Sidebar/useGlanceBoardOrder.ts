// The sidebar's display order for every sort mode, shared by the full sidebar
// and the compact rail so the two never disagree (glance board, 2026-09-25).

import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectAllWorkspaceLastActivityMinute, selectWorkspaceAttentionScores } from '../../stores/selectors/fleet';
import { orderByRecentActivity } from './attentionOrder';
import { glanceOrder, NEW_WORKSPACE_HOLD_MS } from './glanceOrder';
import { useSettledOrder } from './useSettledOrder';

// Frozen stand-ins while a mode is off, so the shallow subscriptions settle.
const NONE: Record<string, number> = {};

export function useGlanceBoardOrder<T extends { id: string }>(manual: readonly T[]) {
  const mode = useStore((s) => s.sidebarSortMode);
  const scores = useStore(useShallow((s) => (s.sidebarSortMode === 'attention' ? selectWorkspaceAttentionScores(s) : NONE)));
  const activity = useStore(useShallow((s) => (s.sidebarSortMode === 'recent' ? selectAllWorkspaceLastActivityMinute(s) : NONE)));
  const pinnedIds = useStore((s) => s.sidebarPinnedIds);
  const newAt = useStore((s) => s.sidebarNewAt);
  const [now, setNow] = useState(() => Date.now());

  // Re-sort when the next new-workspace hold runs out.
  useEffect(() => {
    if (mode !== 'attention') return;
    const t = Date.now();
    const expiries = Object.values(newAt).map((at) => at + NEW_WORKSPACE_HOLD_MS).filter((x) => x > t);
    if (expiries.length === 0) return;
    const id = setTimeout(() => setNow(Date.now()), Math.min(...expiries) - t + 50);
    return () => clearTimeout(id);
  }, [mode, newAt, now]);

  const desired = useMemo(() => {
    if (mode === 'attention') {
      return glanceOrder(manual, (id) => scores[id] ?? Number.MAX_SAFE_INTEGER, new Set(pinnedIds), newAt, Math.max(now, Date.now()));
    }
    if (mode === 'recent') return orderByRecentActivity(manual, (id) => activity[id] ?? 0);
    return manual as T[];
  }, [mode, manual, scores, activity, pinnedIds, newAt, now]);

  return useSettledOrder(desired, mode !== 'manual');
}
