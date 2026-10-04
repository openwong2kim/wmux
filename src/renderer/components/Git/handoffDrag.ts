// Dragging an issue or PR from the Git page onto an agent: the drag types a
// drop target recognises, reading (and re-validating) the dropped ref, and
// turning a pane or a workspace into hand-off targets.
import { ISSUE_DRAG_TYPE, parseIssueRef } from '../../../shared/issueRef';
import { PR_DRAG_TYPE, parsePrDragRef } from '../../../shared/prDragRef';
import { paneAddressOfPty } from '../../hooks/a2aFreshContext';
import { paneHasDetectedAgent } from '../../hooks/a2aAddressing';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { useStore, type StoreState } from '../../stores';
import type { HandoffRef, HandoffTarget } from '../../../shared/gitHandoff';
import type { GitDragContext } from './gitPageState';

/** The only host the Git page reads from. */
const HANDOFF_HOST = 'github.com';

export const HANDOFF_DRAG_TYPES: readonly string[] = [ISSUE_DRAG_TYPE, PR_DRAG_TYPE];

/** The drag carries an issue or PR (types are readable during dragover; the data only on drop). */
export function isHandoffDrag(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).some((t) => HANDOFF_DRAG_TYPES.includes(t));
}

/** A hand-off drag that started on a Git page row (types are readable during
 *  dragover; a drag from anywhere else has no context). */
export function isOurHandoffDrag(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return isHandoffDrag(dt) && !!useStore.getState().gitDragContext;
}

/** The dropped issue or PR, checked against its URL (github.com only); null
 *  for anything else. */
export function readHandoffDrop(dt: Pick<DataTransfer, 'getData' | 'types'>): HandoffRef | null {
  const types = Array.from(dt.types ?? []);
  if (types.includes(ISSUE_DRAG_TYPE)) {
    const ref = parseIssueRef(dt.getData(ISSUE_DRAG_TYPE));
    if (ref && ref.host.toLowerCase() === HANDOFF_HOST) return { kind: 'issue', ref };
  }
  if (types.includes(PR_DRAG_TYPE)) {
    const ref = parsePrDragRef(dt.getData(PR_DRAG_TYPE));
    if (ref && ref.host.toLowerCase() === HANDOFF_HOST) return { kind: 'pr', ref };
  }
  return null;
}

/**
 * A Git page row starts a hand-off drag: remember where it came from, and
 * forget it when the drag ends anywhere. The row itself may be gone by then
 * (holding over Workspaces swaps the page out), so its own dragend cannot be
 * relied on: the window's drop and dragend do it, and failing both, the next
 * press. On drop the clear waits a tick, so the drop target reads it first.
 */
export function beginHandoffDrag(ctx: GitDragContext): void {
  useStore.getState().setGitDragContext(ctx);
  const clear = () => {
    off();
    if (useStore.getState().gitDragContext === ctx) useStore.getState().setGitDragContext(null);
  };
  const onDrop = () => { setTimeout(clear, 0); };
  function off() {
    window.removeEventListener('dragend', clear, true);
    window.removeEventListener('drop', onDrop, true);
    window.removeEventListener('pointerdown', clear, true);
  }
  window.addEventListener('dragend', clear, true);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('pointerdown', clear, true);
}

/**
 * Take a hand-off drop: the dropped ref and where its drag began, or null
 * when the drag did not start on a Git page row or the ref names another
 * repo than that row's (a forged drag). The context is used up either way.
 */
export function takeHandoffDrop(dt: Pick<DataTransfer, 'getData' | 'types'>): { item: HandoffRef; repo: GitDragContext } | null {
  const st = useStore.getState();
  const ctx = st.gitDragContext;
  if (ctx) st.setGitDragContext(null);
  const item = readHandoffDrop(dt);
  if (!item || !ctx) return null;
  const same = ctx.owner.toLowerCase() === item.ref.owner.toLowerCase() && ctx.repo.toLowerCase() === item.ref.repo.toLowerCase();
  return same ? { item, repo: ctx } : null;
}

/** The pane has an agent by the delivery gate's rule: a detected name, not
 *  known gone. Its status does not matter: an agent idle at its first prompt
 *  is a target. */
function hasAgent(state: Pick<StoreState, 'surfaceAgent' | 'agentAliveByPtyId' | 'commandRunningByPtyId'>, ptyId: string): boolean {
  return paneHasDetectedAgent(ptyId, state.surfaceAgent ?? {}, {
    agentAlive: state.agentAliveByPtyId,
    commandRunning: state.commandRunningByPtyId,
  });
}

/** The hand-off target for a pane's terminal, or null when no workspace holds it. */
export function handoffTargetForPty(
  state: Pick<StoreState, 'workspaces' | 'surfaceAgent' | 'agentAliveByPtyId' | 'commandRunningByPtyId'>,
  ptyId: string,
): HandoffTarget | null {
  const addr = paneAddressOfPty(state.workspaces, ptyId);
  if (!addr) return null;
  const agent = hasAgent(state, ptyId) ? state.surfaceAgent[ptyId] : undefined;
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
    .filter((r) => !r.remote && !r.stashed && hasAgent(state, r.ptyId))
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
