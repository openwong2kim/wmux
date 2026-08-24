import type { AgentStatus } from '../../../shared/types';
import { isBrainPtyId } from '../../../shared/constants';
import { getLeafPanes } from '../../../shared/paneUtils';
import { stashedPaneLiveness, type StashedLiveness } from '../../../shared/paneStash';
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
  /**
   * #977 — this pane is stashed: owned and running, but not in the layout.
   * Stashed rows are PANE-level (one row per pane, keyed by paneId), unlike the
   * visible rows above which are one per terminal surface. A stashed pane has
   * no active tab on screen, so a per-surface row would make the disclosure
   * count disagree with the number of things the user can click, and clicking
   * any of N rows would do the same thing.
   */
  stashed?: boolean;
  /** Derived, never stored — see `stashedPaneLiveness`. Stashed rows only. */
  stashedLiveness?: StashedLiveness;
  /** When it was stashed, for the "2h ago" trailer. Stashed rows only. */
  stashedAt?: number;
}

export interface WorkspaceAgentRosterProjection {
  rows: WorkspaceAgentRosterRow[];
  agentCount: number;
  needsAttentionCount: number;
  /** Number of stashed PANES (not surfaces) — see WorkspaceAgentRosterRow.stashed. */
  stashedCount: number;
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
  if (!workspace) return { rows: [], agentCount: 0, needsAttentionCount: 0, stashedCount: 0 };

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

  const agentCount = rows.length;

  // ── Stashed panes (#977) ───────────────────────────────────────────────────
  // Appended AFTER the visible agents, in stash order. Two rules differ from
  // the loop above, both deliberate:
  //
  //   1. The agent gate is relaxed. A visible shell pane with no detected agent
  //      is excluded so the roster does not flood with plain terminals — the
  //      user can see those panes. A STASHED shell pane is on no other surface
  //      in the app, so excluding it would make a running session a ghost:
  //      alive, consuming resources, and listed nowhere.
  //   2. One row per pane, not per surface. See WorkspaceAgentRosterRow.stashed.
  for (const entry of workspace.stashedPanes ?? []) {
    const leaf = entry?.pane;
    if (!leaf || leaf.type !== 'leaf') continue;
    const terminals = leaf.surfaces.filter((s) => (s.surfaceType ?? 'terminal') === 'terminal');
    // Which tab represents the pane in its single row. The remembered active
    // tab wins WHILE IT IS ALIVE — that was the user's last choice. But
    // activeness alone is not enough: it points at whatever was on top when the
    // pane left the screen, so if THAT session died while a sibling is still
    // running, deferring to it would report the whole pane as exited with an
    // agent working behind it. Order: the active tab if live, then a live tab
    // that has a detected agent, then any live tab, then the dead remnants.
    const live = terminals.filter((s) => !!s.ptyId);
    const surface =
      live.find((s) => s.id === leaf.activeSurfaceId)
      ?? live.find((s) => !!state.surfaceAgent[s.ptyId]?.name)
      ?? live[0]
      ?? terminals.find((s) => s.id === leaf.activeSurfaceId)
      ?? terminals[0]
      ?? leaf.surfaces[0];
    if (!surface) continue;
    const ptyId = surface.ptyId;
    if (isBrainPtyId(ptyId)) continue;

    const liveness = stashedPaneLiveness(leaf);
    const agent = ptyId ? state.surfaceAgent[ptyId] : undefined;
    const pendingQuestion = ptyId ? nonEmpty(state.surfacePendingQuestion[ptyId]) : undefined;
    const attentionStatus = ptyId ? state.surfaceAgentStatus[ptyId] : undefined;
    const activityAt = (ptyId ? state.surfaceActivityAt[ptyId] : 0) ?? 0;
    const activityIsFresh =
      activityAt > 0 && state.agentClockMs - activityAt <= HOOK_RUNNING_TTL_MS;

    // An exited pane has no status to report — the session is gone, and painting
    // it 'idle' would be indistinguishable from a quiet agent. The row says
    // "session ended" instead and offers recovery.
    let status: AgentStatus;
    if (liveness === 'exited') {
      status = 'error';
    } else if (pendingQuestion) {
      status = 'awaiting_input';
    } else {
      const lifecycle: AgentStatus =
        agent?.status === 'running' && !activityIsFresh ? 'idle' : (agent?.status ?? 'idle');
      status = attentionStatus ?? lifecycle;
      if (!attentionStatus && lifecycle === 'idle' && activityIsFresh) status = 'running';
    }

    rows.push({
      workspaceId,
      paneId: leaf.id,
      surfaceId: surface.id,
      ptyId,
      agentName: agent?.name ?? '',
      paneName: paneDisplayName(
        state.paneLabel[leaf.id],
        computePaneAutoName(workspace.wsOrdinal ?? 0, leaf.ordinal ?? 0),
      ),
      surfaceTitle: nonEmpty(surface.title),
      surfaceIndex: Math.max(0, leaf.surfaces.findIndex((s) => s.id === surface.id)),
      surfaceCount: leaf.surfaces.length,
      status,
      attentionStatus,
      pendingQuestion,
      activity: status === 'running' && activityIsFresh && ptyId
        ? nonEmpty(state.surfaceActivity[ptyId])
        : undefined,
      hasAttention: attentionStatus !== undefined || pendingQuestion !== undefined,
      needsAttention: liveness === 'exited' || needsAttention(status),
      isFocused: false,
      stashed: true,
      stashedLiveness: liveness,
      stashedAt: entry.stashedAt,
    });
  }

  return {
    rows,
    agentCount,
    needsAttentionCount: rows.reduce(
      (count, row) => count + (row.needsAttention ? 1 : 0),
      0,
    ),
    stashedCount: rows.length - agentCount,
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
      a.isFocused !== b.isFocused ||
      a.stashed !== b.stashed ||
      a.stashedLiveness !== b.stashedLiveness ||
      a.stashedAt !== b.stashedAt
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
      previous.stashedCount === next.stashedCount &&
      rowsEqual(previous.rows, next.rows)
    ) {
      return previous;
    }
    previous = next;
    return next;
  };
}
