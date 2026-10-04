/**
 * Moa's HQ workspace is app-owned: hidden from the normal workspace list and
 * never closed or archived by the operator. Every close path asks
 * `workspaceCloseRefusal` (or its toasting wrapper `refuseWorkspaceClose`)
 * BEFORE it disposes a PTY: the store refuses too, but only after the caller
 * has already torn the sessions down, leaving a dead, empty workspace.
 */
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { isMoaHqWorkspace, listedWorkspaces, moaHqId } from '../../stores/slices/moaSlice';
import { t } from '../../i18n';

export { listedWorkspaces, moaHqId };

type CloseView = Pick<StoreState, 'moa' | 'workspaces'> & { moaHqSeed?: string | null };

/** Why closing (or archiving) `workspaceId` would be refused, or null when it
 *  would go through: the HQ is never closed, and the operator always keeps one
 *  workspace of their own (the HQ does not count). An unknown id is not a
 *  refusal here; callers already handle it. */
export function workspaceCloseRefusal(state: CloseView, workspaceId: string): 'moa-hq' | 'last-workspace' | null {
  if (isMoaHqWorkspace(state, workspaceId)) return 'moa-hq';
  if (listedWorkspaces(state.workspaces, moaHqId(state)).length <= 1) return 'last-workspace';
  return null;
}

/** True (with a toast giving the reason) when closing `workspaceId` would be
 *  refused. Call it before any dispose. `state` defaults to the live store;
 *  tests and injected stores pass theirs. */
export function refuseWorkspaceClose(
  workspaceId: string,
  state: CloseView & Partial<Pick<StoreState, 'pushToast'>> = useStore.getState(),
): boolean {
  const refusal = workspaceCloseRefusal(state, workspaceId);
  if (!refusal) return false;
  state.pushToast?.({ level: 'info', message: t(refusal === 'moa-hq' ? 'moa.guard.reason' : 'workspace.closeLastRefused') });
  return true;
}
