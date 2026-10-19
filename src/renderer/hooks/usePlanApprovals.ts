import { useEffect, useState } from 'react';
import type { PlanApprovalView } from '../../shared/planApproval';

/**
 * Claude's pending plan dialogs (Fleet's Plan cards), read again on every
 * daemon approval change. A failed read shows none: a card must never stay up
 * for a dialog nobody can confirm is still there.
 */
export function usePlanApprovals(): PlanApprovalView[] {
  const [plans, setPlans] = useState<PlanApprovalView[]>([]);
  useEffect(() => {
    const api = window.electronAPI?.planApprovals;
    if (!api) return undefined;
    let alive = true;
    let seq = 0;
    const refresh = (): void => {
      const mine = ++seq;
      api.list()
        .then((list) => { if (alive && mine === seq) setPlans(list); })
        .catch(() => { if (alive && mine === seq) setPlans([]); });
    };
    refresh();
    const off = api.onChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return plans;
}
