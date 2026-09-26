// The sidebar's display order for every sort mode, shared by the full sidebar
// and the compact rail so the two never disagree (glance board, 2026-09-25).
// The pinned group leads in every mode and is shown as stored; only the rows
// below it re-sort, under the settle rule (pinned to top, 2026-09-26).

import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectAllWorkspaceLastActivityMinute, selectWorkspaceAttentionScores } from '../../stores/selectors/fleet';
import { boardOrder, NEW_WORKSPACE_HOLD_MS } from './glanceOrder';
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

  const board = useMemo(() => boardOrder({
    manual,
    mode,
    pinned: new Set(pinnedIds),
    scoreOf: (id) => scores[id],
    activityOf: (id) => activity[id],
    newAt,
    now: Math.max(now, Date.now()),
    nestedOwnerOf,
  }), [mode, manual, scores, activity, pinnedIds, newAt, now, nestedOwnerOf]);

  // A row crossing the group boundary is a membership change of `rest`, which
  // the settle rule lands at once (reconcileAppliedOrder).
  const settled = useSettledOrder(board.rest, mode !== 'manual');
  const ordered = useMemo(() => [...board.pinned, ...settled.ordered], [board.pinned, settled.ordered]);
  return { ...settled, ordered };
}
