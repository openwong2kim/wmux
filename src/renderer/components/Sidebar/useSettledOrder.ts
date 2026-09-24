// No live reshuffle under the pointer (owner decision 2026-09-25): a display
// order that re-sorts itself is applied only once the list has been quiet for
// GLANCE_SETTLE_MS — or, under changes that never stop, GLANCE_MAX_WAIT_MS after
// the first one — and never while the pointer or keyboard focus is inside the
// list (a row being aimed at, a rename input). Leaving applies a pending order
// at once. Membership changes (a workspace added or removed) land immediately —
// see reconcileAppliedOrder.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GLANCE_MAX_WAIT_MS, GLANCE_SETTLE_MS, reconcileAppliedOrder } from './glanceOrder';

export interface SettledOrderHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusCapture: () => void;
  onBlurCapture: (e: React.FocusEvent<HTMLElement>) => void;
}

export function useSettledOrder<T extends { id: string }>(
  desired: readonly T[],
  enabled: boolean,
  settleMs = GLANCE_SETTLE_MS,
  maxWaitMs = GLANCE_MAX_WAIT_MS,
): { ordered: T[] } & SettledOrderHandlers {
  const desiredIds = useMemo(() => desired.map((d) => d.id), [desired]);
  const desiredKey = desiredIds.join('\u0000');
  const [applied, setAppliedState] = useState<string[]>(desiredIds);
  // The order on screen, readable synchronously inside the effect below.
  const appliedRef = useRef<string[]>(desiredIds);
  const setApplied = useCallback((order: string[]) => {
    appliedRef.current = order;
    setAppliedState(order);
  }, []);
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  const pending = useRef(false);
  const firstPendingAt = useRef<number | null>(null);
  const latest = useRef(desiredIds);
  latest.current = desiredIds;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const held = () => pointerInside.current || focusInside.current;
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const applyNow = useCallback(() => {
    clearTimer();
    pending.current = false;
    firstPendingAt.current = null;
    setApplied(latest.current);
  }, [setApplied]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      pending.current = false;
      firstPendingAt.current = null;
      setApplied(latest.current);
      return;
    }
    const r = reconcileAppliedOrder(appliedRef.current, latest.current);
    pending.current = r.pending;
    if (!r.pending) firstPendingAt.current = null;
    else if (firstPendingAt.current === null) firstPendingAt.current = Date.now();
    setApplied(r.order);
    // The settle restarts on every change, capped by the max wait counted from
    // the first pending change, so a list that never goes quiet still re-sorts.
    clearTimer();
    const since = firstPendingAt.current === null ? 0 : Date.now() - firstPendingAt.current;
    const delay = Math.max(0, Math.min(settleMs, maxWaitMs - since));
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pending.current && !held()) applyNow();
    }, delay);
    // desiredKey stands in for `desired` (same ids → same order); latest.current carries the value.
  }, [desiredKey, enabled, settleMs, maxWaitMs, applyNow, setApplied]);

  useEffect(() => clearTimer, []);

  const releaseIfFree = useCallback(() => {
    if (pending.current && !held()) applyNow();
  }, [applyNow]);
  const onPointerEnter = useCallback(() => { pointerInside.current = true; }, []);
  const onPointerLeave = useCallback(() => { pointerInside.current = false; releaseIfFree(); }, [releaseIfFree]);
  const onFocusCapture = useCallback(() => { focusInside.current = true; }, []);
  const onBlurCapture = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    focusInside.current = false;
    releaseIfFree();
  }, [releaseIfFree]);

  const byId = useMemo(() => new Map(desired.map((d) => [d.id, d])), [desired]);
  const ordered = useMemo(
    () => (enabled ? applied : desiredIds).map((id) => byId.get(id)).filter((x): x is T => x !== undefined),
    [enabled, applied, desiredIds, byId],
  );
  return { ordered, onPointerEnter, onPointerLeave, onFocusCapture, onBlurCapture };
}
