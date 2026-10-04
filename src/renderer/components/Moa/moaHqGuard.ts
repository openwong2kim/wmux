/**
 * Moa's HQ workspace is app-owned: hidden from the normal workspace list and
 * never closed or archived by the operator. Every UI close path asks
 * `refuseIfMoaHq` BEFORE it disposes a PTY (the store refuses too, but only
 * after the caller has already torn the sessions down).
 */
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { isMoaHqWorkspace } from '../../stores/slices/moaSlice';
import { t } from '../../i18n';

/** The HQ workspace id, or null when there is none. */
export function moaHqId(state: Pick<StoreState, 'moa'>): string | null {
  return state.moa?.hq.workspaceId ?? null;
}

/** The workspaces the operator sees (and Ctrl+N counts): all but the HQ. */
export function listedWorkspaces<T extends { id: string }>(list: readonly T[], hqId: string | null): T[] {
  return hqId ? list.filter((w) => w.id !== hqId) : [...list];
}

/** True (with a toast giving the reason) when `workspaceId` is the HQ.
 *  `state` defaults to the live store; tests and injected stores pass theirs. */
export function refuseIfMoaHq(
  workspaceId: string,
  state: Pick<StoreState, 'moa' | 'pushToast'> = useStore.getState(),
): boolean {
  if (!isMoaHqWorkspace(state, workspaceId)) return false;
  state.pushToast({ level: 'info', message: t('moa.guard.reason') });
  return true;
}
