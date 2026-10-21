/**
 * The shared pre-close check: the operator always keeps one workspace of their
 * own. Every close path asks `workspaceCloseRefusal` (or its toasting wrapper
 * `refuseWorkspaceClose`) BEFORE it disposes a PTY: the store refuses too, but
 * only after the caller has already torn the sessions down, leaving a dead,
 * empty workspace.
 */
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { t } from '../../i18n';
import { isShadowWorkspaceId, listedWorkspaces } from '../../../shared/pcRail';

export { listedWorkspaces };

type CloseView = Pick<StoreState, 'workspaces'>;

/** Why closing (or archiving) `workspaceId` would be refused, or null when it
 *  would go through: the operator always keeps one workspace of their own. An
 *  unknown id is not a refusal here; callers already handle it. */
export function workspaceCloseRefusal(state: CloseView, workspaceId: string): 'last-workspace' | null {
  // Closing another computer's (shadow) workspace only detaches its tabs; it
  // is never one of the operator's own, so it is never the last one.
  if (isShadowWorkspaceId(workspaceId)) return null;
  if (listedWorkspaces(state.workspaces).length <= 1) return 'last-workspace';
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
  state.pushToast?.({ level: 'info', message: t('workspace.closeLastRefused') });
  return true;
}
