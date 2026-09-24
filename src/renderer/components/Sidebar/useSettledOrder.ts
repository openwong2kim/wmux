// No live reshuffle under the pointer (owner decision 2026-09-25): a display
// order that re-sorts itself is applied only once the list has been quiet for
// GLANCE_SETTLE_MS, or at once when the pointer leaves the list. Membership
// changes (a workspace added or removed) land immediately — see
// reconcileAppliedOrder.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GLANCE_SETTLE_MS, reconcileAppliedOrder } from './glanceOrder';

export function useSettledOrder<T extends { id: string }>(
  desired: readonly T[],
  enabled: boolean,
  settleMs = GLANCE_SETTLE_MS,
): { ordered: T[]; onPointerEnter: () => void; onPointerLeave: () => void } {
  const desiredIds = useMemo(() => desired.map((d) => d.id), [desired]);
  const desiredKey = desiredIds.join('\u0000');
  const [applied, setApplied] = useState<string[]>(desiredIds);
  const pointerInside = useRef(false);
  const pending = useRef(false);
  const latest = useRef(desiredIds);
  latest.current = desiredIds;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const applyNow = useCallback(() => {
    clearTimer();
    pending.current = false;
    setApplied(latest.current);
  }, []);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      pending.current = false;
      setApplied(latest.current);
      return;
    }
    setApplied((prev) => {
      const r = reconcileAppliedOrder(prev, latest.current);
      pending.current = r.pending;
      return r.order;
    });
    // The settle restarts on every change: the order applies once it has
    // stopped moving, never mid-burst.
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pending.current && !pointerInside.current) applyNow();
    }, settleMs);
    // desiredKey stands in for `desired` (same ids → same order); latest.current carries the value.
  }, [desiredKey, enabled, settleMs, applyNow]);

  useEffect(() => clearTimer, []);

  const onPointerEnter = useCallback(() => {
    pointerInside.current = true;
  }, []);
  const onPointerLeave = useCallback(() => {
    pointerInside.current = false;
    if (pending.current) applyNow();
  }, [applyNow]);

  const byId = useMemo(() => new Map(desired.map((d) => [d.id, d])), [desired]);
  const ordered = useMemo(
    () => (enabled ? applied : desiredIds).map((id) => byId.get(id)).filter((x): x is T => x !== undefined),
    [enabled, applied, desiredIds, byId],
  );
  return { ordered, onPointerEnter, onPointerLeave };
}
