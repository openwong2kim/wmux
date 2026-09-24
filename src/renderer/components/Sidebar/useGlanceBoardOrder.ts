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

/**
 * @param nestedOwnerOf For the full sidebar: the owner a fan-out task renders
 *   under (non-detached, owner open), else undefined. Nested tasks take no
 *   top-level slot — they render under their owner — and an owner scores as
 *   its most urgent task, so a task that needs you lifts its whole group.
 */
export function useGlanceBoardOrder<T extends { id: string }>(
  manual: readonly T[],
  nestedOwnerOf?: (id: string) => string | undefined,
) {
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
      const top: T[] = [];
      const nested: T[] = [];
      const effective: Record<string, number> = {};
      for (const item of manual) {
        const owner = nestedOwnerOf?.(item.id);
        if (owner) nested.push(item);
        else top.push(item);
      }
      for (const item of top) effective[item.id] = scores[item.id] ?? Number.MAX_SAFE_INTEGER;
      for (const item of nested) {
        const owner = nestedOwnerOf?.(item.id) as string;
        if (effective[owner] === undefined) continue;
        effective[owner] = Math.min(effective[owner], scores[item.id] ?? Number.MAX_SAFE_INTEGER);
      }
      const ordered = glanceOrder(top, (id) => effective[id] ?? Number.MAX_SAFE_INTEGER, new Set(pinnedIds), newAt, Math.max(now, Date.now()));
      return [...ordered, ...nested];
    }
    if (mode === 'recent') return orderByRecentActivity(manual, (id) => activity[id] ?? 0);
    return manual as T[];
  }, [mode, manual, scores, activity, pinnedIds, newAt, now, nestedOwnerOf]);

  return useSettledOrder(desired, mode !== 'manual');
}
