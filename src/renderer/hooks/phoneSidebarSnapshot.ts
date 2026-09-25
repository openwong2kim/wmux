// Pure builder for the renderer's `workspace.phoneSidebar` reply: the desktop
// sidebar's per-workspace and per-pane labels, projected for the phone Fleet.
//
// A separate projection rather than new keys on `workspace.list`, because that
// reply is shared byte-for-byte with the WorkspaceMirror push and is the public
// `workspace.list` RPC (CLI, MCP, hook bridges). The phone's fields reach none
// of them.
//
// Every value here is one the sidebar already derives — nothing is computed
// fresh, so the phone and the desktop cannot disagree:
//   - order:        the row's index in the unfiltered workspace list (the
//                   manual order Sidebar passes as `index`)
//   - pinned/color: `sidebarPinnedIds` / `Workspace.color`
//   - git fields:   `Workspace.metadata` (the git sync badge's own source)
//   - task:         `resolveTaskLink`, with WorkspaceItem's provenance time
//   - nested:       `buildSidebarTree` membership (drawn under its owner)
//   - task state:   SidebarTaskGroup's rollup bits, per nested task; the
//                   daemon folds them into the owner's summary
//   - panes:        the roster's pane display name and surface title rules
//
// Store-free (state in, plain object out) so it is unit-testable directly.

import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { isBrainPtyId } from '../../shared/constants';
import {
  PHONE_SIDEBAR_LIMITS,
  clampSidebarString,
  type PhoneSidebarPane,
  type PhoneSidebarSnapshot,
  type PhoneSidebarWorkspace,
  type SidebarDropReporter,
} from '../../shared/phoneFleetSidebar';
import type { StoreState } from '../stores';
import { resolveTaskLink } from '../utils/fanoutProvenance';
import { computePaneAutoName, paneDisplayName } from '../utils/paneNaming';
import { buildSidebarTree, paneRowsFinished, taskRollup } from '../components/Sidebar/sidebarTree';
import { selectWorkspaceAgentStatus } from '../stores/selectors/fleet';
import { selectWorkspaceAgentRoster, agentSurfaceTitle } from '../stores/selectors/workspaceAgentRoster';
import { isTaskReadyForReview } from '../stores/selectors/reviewQueue';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * One bad workspace, task record or pane never costs the whole snapshot: each
 * part is projected on its own, and a part that throws is left out and
 * reported to `onDrop` by a reason tag (never the value).
 */
export function buildPhoneSidebarSnapshot(state: StoreState, onDrop: SidebarDropReporter = () => undefined): PhoneSidebarSnapshot {
  const workspaces = state.workspaces;
  const liveIds = new Set(workspaces.map((w) => w.id));
  const linkOf = (id: string) =>
    resolveTaskLink(state.missionByPaneGroup[id], state.fanoutLineage[id], state.fanoutSpawnOwner[id]);
  // The nesting the sidebar draws: which tasks sit under which owner row.
  // Order does not change membership, so the manual order stands in for the
  // sidebar's display sort here.
  let nestedTaskIds = new Set<string>();
  try {
    const tree = buildSidebarTree(workspaces, linkOf, liveIds);
    nestedTaskIds = new Set(tree.top.flatMap((node) => node.taskIds));
  } catch {
    // No nesting this round; every other field still goes out.
    onDrop('task.tree');
  }
  const pinned = new Set(state.sidebarPinnedIds ?? []);

  const workspaceRows: PhoneSidebarWorkspace[] = [];
  workspaces.slice(0, PHONE_SIDEBAR_LIMITS.workspaces).forEach((ws, order) => {
    let row: PhoneSidebarWorkspace;
    try {
      row = projectWorkspaceBase(ws, order, pinned);
    } catch {
      onDrop('workspace.row');
      return;
    }
    try {
      projectTask(row);
    } catch {
      delete row.task;
      onDrop('workspace.task');
    }
    workspaceRows.push(row);
  });

  function projectWorkspaceBase(ws: StoreState['workspaces'][number], order: number, pinnedIds: ReadonlySet<string>): PhoneSidebarWorkspace {
    const row: PhoneSidebarWorkspace = { id: ws.id, order, pinned: pinnedIds.has(ws.id) };
    if (ws.color) row.color = ws.color;
    const branch = clampSidebarString(ws.metadata?.gitBranch, PHONE_SIDEBAR_LIMITS.gitBranch);
    if (branch) row.gitBranch = branch;
    if (typeof ws.metadata?.gitIsWorktree === 'boolean') row.gitIsWorktree = ws.metadata.gitIsWorktree;
    const sync = ws.metadata?.gitSync;
    if (sync) row.gitSync = { ahead: sync.ahead, behind: sync.behind, hasUpstream: sync.hasUpstream };
    return row;
  }

  function projectTask(row: PhoneSidebarWorkspace): void {
    const id = row.id;
    const link = linkOf(id);
    if (link) {
      // WorkspaceItem's tooltip time: who-asked audit record first, else the task record.
      const createdAt = state.fanoutProvenance?.[id]?.at ?? state.missionByPaneGroup[id]?.createdAt;
      const nested = nestedTaskIds.has(id);
      row.task = {
        ownerWorkspaceId: link.ownerId || null,
        detached: link.detached,
        ...(typeof createdAt === 'number' && createdAt > 0 ? { createdAt } : {}),
        nested,
      };
      if (nested) {
        // One task through SidebarTaskGroup's own rollup and finished rule, so
        // each bit is exactly what the owner's rollup line counts for it.
        const one = taskRollup(
          [id],
          (taskId) => selectWorkspaceAgentStatus(state, taskId),
          (taskId) => isTaskReadyForReview(state, taskId),
        );
        row.task.state = {
          needYou: (one?.needYou ?? 0) > 0,
          toReview: (one?.toReview ?? 0) > 0,
          finished: paneRowsFinished(selectWorkspaceAgentRoster(state, id).rows),
        };
      }
    }
  }

  const paneRows: PhoneSidebarPane[] = [];
  outer: for (const ws of workspaces) {
    // Visible and stashed leaves alike (#977): a stashed pane is still a live
    // session the phone lists.
    let leaves: ReturnType<typeof getWorkspaceLeafPanes>;
    try {
      leaves = getWorkspaceLeafPanes(ws);
    } catch {
      onDrop('pane.workspace');
      continue;
    }
    for (const leaf of leaves) {
      try {
        // The coordinate is always included when the pane has no label of its
        // own; the desktop's "show pane coordinates" toggle is a sidebar
        // density preference, and the phone decides its own density.
        const paneName = clampSidebarString(
          paneDisplayName(state.paneLabel?.[leaf.id], computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0)),
          PHONE_SIDEBAR_LIMITS.paneName,
        );
        for (const surface of leaf.surfaces) {
          if ((surface.surfaceType ?? 'terminal') !== 'terminal') continue;
          const ptyId = surface.ptyId;
          if (!ptyId || isBrainPtyId(ptyId)) continue;
          if (paneRows.length >= PHONE_SIDEBAR_LIMITS.panes) break outer;
          // The roster's rule (what `rosterPrimaryLabel` leads with): an agent
          // row drops a tab still titled after its host shell; any other pane
          // keeps its title as-is.
          const rawTitle = state.surfaceAgent?.[ptyId]?.name ? agentSurfaceTitle(surface) : nonEmpty(surface.title);
          const surfaceTitle = clampSidebarString(rawTitle, PHONE_SIDEBAR_LIMITS.surfaceTitle);
          paneRows.push({
            ptyId,
            workspaceId: ws.id,
            ...(surfaceTitle ? { surfaceTitle } : {}),
            ...(paneName ? { paneName } : {}),
          });
        }
      } catch {
        onDrop('pane.row');
      }
    }
  }

  return {
    activeWorkspaceId: state.activeWorkspaceId && liveIds.has(state.activeWorkspaceId) ? state.activeWorkspaceId : null,
    workspaces: workspaceRows,
    panes: paneRows,
  };
}
