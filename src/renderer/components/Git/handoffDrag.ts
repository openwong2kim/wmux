// Dragging an issue or PR from the Git page onto an agent: the drag types a
// drop target recognises, reading (and re-validating) the dropped ref, and
// turning a pane or a workspace into hand-off targets.
import { ISSUE_DRAG_TYPE, parseIssueRef } from '../../../shared/issueRef';
import { PR_DRAG_TYPE, parsePrDragRef } from '../../../shared/prDragRef';
import { paneAddressOfPty } from '../../hooks/a2aFreshContext';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import type { StoreState } from '../../stores';
import type { HandoffRef, HandoffTarget } from '../../../shared/gitHandoff';

export const HANDOFF_DRAG_TYPES: readonly string[] = [ISSUE_DRAG_TYPE, PR_DRAG_TYPE];

/** The drag carries an issue or PR (types are readable during dragover; the data only on drop). */
export function isHandoffDrag(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).some((t) => HANDOFF_DRAG_TYPES.includes(t));
}

/** The dropped issue or PR, checked against its URL; null for anything else. */
export function readHandoffDrop(dt: Pick<DataTransfer, 'getData' | 'types'>): HandoffRef | null {
  const types = Array.from(dt.types ?? []);
  if (types.includes(ISSUE_DRAG_TYPE)) {
    const ref = parseIssueRef(dt.getData(ISSUE_DRAG_TYPE));
    if (ref) return { kind: 'issue', ref };
  }
  if (types.includes(PR_DRAG_TYPE)) {
    const ref = parsePrDragRef(dt.getData(PR_DRAG_TYPE));
    if (ref) return { kind: 'pr', ref };
  }
  return null;
}

/** The hand-off target for a pane's terminal, or null when no workspace holds it. */
export function handoffTargetForPty(state: Pick<StoreState, 'workspaces' | 'surfaceAgent'>, ptyId: string): HandoffTarget | null {
  const addr = paneAddressOfPty(state.workspaces, ptyId);
  if (!addr) return null;
  const agent = state.surfaceAgent?.[ptyId];
  return {
    workspaceId: addr.workspaceId,
    paneId: addr.paneId,
    surfaceId: addr.surfaceId,
    ptyId,
    agentName: agent?.name ?? '',
    ...(agent?.slug ? { agentSlug: agent.slug } : {}),
  };
}

/** The local, visible agent panes of a workspace as hand-off targets. */
export function handoffTargetsInWorkspace(state: StoreState, workspaceId: string): HandoffTarget[] {
  return selectWorkspaceAgentRoster(state, workspaceId).rows
    .filter((r) => !r.remote && !r.stashed)
    .map((r) => ({
      workspaceId: r.workspaceId,
      paneId: r.paneId,
      surfaceId: r.surfaceId,
      ptyId: r.ptyId,
      agentName: r.agentName,
      ...(r.slug ? { agentSlug: r.slug } : {}),
    }));
}

/** Every local agent pane across workspaces (the "Send to agent…" picker). */
export function allHandoffTargets(state: StoreState): HandoffTarget[] {
  return state.workspaces.flatMap((w) => handoffTargetsInWorkspace(state, w.id));
}
