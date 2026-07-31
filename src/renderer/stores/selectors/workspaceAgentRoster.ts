import type { AgentStatus } from '../../../shared/types';
import { isBrainPtyId } from '../../../shared/constants';
import { getLeafPanes } from '../../../shared/paneUtils';
import type { StoreState } from '../index';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';
import { HOOK_RUNNING_TTL_MS } from './fleet';

/** One detected agent session, kept attached to the terminal surface that owns it. */
export interface WorkspaceAgentRosterRow {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  ptyId: string;
  agentName: string;
  paneName: string;
  surfaceTitle?: string;
  surfaceIndex: number;
  surfaceCount: number;
  status: AgentStatus;
  attentionStatus?: AgentStatus;
  pendingQuestion?: string;
  activity?: string;
  hasAttention: boolean;
  needsAttention: boolean;
  isFocused: boolean;
}

export interface WorkspaceAgentRosterProjection {
  rows: WorkspaceAgentRosterRow[];
  agentCount: number;
  needsAttentionCount: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function needsAttention(status: AgentStatus): boolean {
  return status === 'awaiting_input' || status === 'waiting' || status === 'error';
}

/**
 * Build a surface-accurate workspace roster.
 *
 * This deliberately does not reuse selectFleetPanes: Fleet rows aggregate the
 * most urgent status in a leaf onto that leaf's active surface, which is useful
 * for a pane card but can associate a background tab's status with the wrong
 * agent. Roster identity and status always remain keyed to the same PTY.
 */
export function selectWorkspaceAgentRoster(
  state: StoreState,
  workspaceId: string,
): WorkspaceAgentRosterProjection {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return { rows: [], agentCount: 0, needsAttentionCount: 0 };

  const rows: WorkspaceAgentRosterRow[] = [];
  for (const leaf of getLeafPanes(workspace.rootPane)) {
    const paneName = paneDisplayName(
      state.paneLabel[leaf.id],
      computePaneAutoName(workspace.wsOrdinal ?? 0, leaf.ordinal ?? 0),
    );

    leaf.surfaces.forEach((surface, surfaceIndex) => {
      if ((surface.surfaceType ?? 'terminal') !== 'terminal') return;
      const ptyId = surface.ptyId;
      if (!ptyId || isBrainPtyId(ptyId)) return;

      const agent = state.surfaceAgent[ptyId];
      if (!agent?.name) return;

      const pendingQuestion = nonEmpty(state.surfacePendingQuestion[ptyId]);
      const attentionStatus = state.surfaceAgentStatus[ptyId];
      const activityAt = state.surfaceActivityAt[ptyId] ?? 0;
      const activityIsFresh =
        activityAt > 0 && state.agentClockMs - activityAt <= HOOK_RUNNING_TTL_MS;

      // Identity-only boot hydration currently seeds `running` without an
      // activity signal. Treat that synthetic value as idle until live output
      // or a hook proves the agent is working; otherwise a quiet recovered
      // pane would pulse forever and disagree with the workspace aggregate.
      const lifecycleStatus: AgentStatus =
        agent.status === 'running' && !activityIsFresh ? 'idle' : agent.status;

      // A transcript-derived pending question is the strongest evidence that
      // this agent needs input. Otherwise an unseen attention state outranks
      // the retained lifecycle state. A fresh activity stamp can promote idle
      // to running, while complete/waiting/error remain explicit states.
      let status: AgentStatus = pendingQuestion
        ? 'awaiting_input'
        : attentionStatus ?? lifecycleStatus;
      if (
        !attentionStatus &&
        !pendingQuestion &&
        lifecycleStatus === 'idle' &&
        activityIsFresh
      ) {
        status = 'running';
      }

      const activity = status === 'running' && activityIsFresh
        ? nonEmpty(state.surfaceActivity[ptyId])
        : undefined;

      rows.push({
        workspaceId,
        paneId: leaf.id,
        surfaceId: surface.id,
        ptyId,
        agentName: agent.name,
        paneName,
        surfaceTitle: nonEmpty(surface.title),
        surfaceIndex,
        surfaceCount: leaf.surfaces.length,
        status,
        attentionStatus,
        pendingQuestion,
        activity,
        hasAttention: attentionStatus !== undefined || pendingQuestion !== undefined,
        needsAttention: needsAttention(status),
        isFocused:
          state.activeWorkspaceId === workspaceId &&
          workspace.activePaneId === leaf.id &&
          leaf.activeSurfaceId === surface.id,
      });
    });
  }

  return {
    rows,
    agentCount: rows.length,
    needsAttentionCount: rows.reduce(
      (count, row) => count + (row.needsAttention ? 1 : 0),
      0,
    ),
  };
}

function rowsEqual(
  previous: WorkspaceAgentRosterRow[],
  next: WorkspaceAgentRosterRow[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (
      a.workspaceId !== b.workspaceId ||
      a.paneId !== b.paneId ||
      a.surfaceId !== b.surfaceId ||
      a.ptyId !== b.ptyId ||
      a.agentName !== b.agentName ||
      a.paneName !== b.paneName ||
      a.surfaceTitle !== b.surfaceTitle ||
      a.surfaceIndex !== b.surfaceIndex ||
      a.surfaceCount !== b.surfaceCount ||
      a.status !== b.status ||
      a.attentionStatus !== b.attentionStatus ||
      a.pendingQuestion !== b.pendingQuestion ||
      a.activity !== b.activity ||
      a.hasAttention !== b.hasAttention ||
      a.needsAttention !== b.needsAttention ||
      a.isFocused !== b.isFocused
    ) {
      return false;
    }
  }
  return true;
}

/**
 * WorkspaceItem instances subscribe independently. Preserve the previous
 * projection reference across unrelated store writes so activity in one
 * workspace does not rerender every sidebar row.
 */
export function createWorkspaceAgentRosterSelector(
  workspaceId: string,
): (state: StoreState) => WorkspaceAgentRosterProjection {
  let previous: WorkspaceAgentRosterProjection | undefined;
  return (state) => {
    const next = selectWorkspaceAgentRoster(state, workspaceId);
    if (
      previous &&
      previous.needsAttentionCount === next.needsAttentionCount &&
      rowsEqual(previous.rows, next.rows)
    ) {
      return previous;
    }
    previous = next;
    return next;
  };
}
