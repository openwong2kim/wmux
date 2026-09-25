import type { AgentStatus } from '../../../shared/types';
import { isBrainPtyId } from '../../../shared/constants';
import { getLeafPanes } from '../../../shared/paneUtils';
import { stashedPaneLiveness, type StashedLiveness } from '../../../shared/paneStash';
import { remoteAgentKey } from '../../../shared/remoteHosts';
import { agentDisplayToSlug } from '../../../shared/agentIdentity';
import type { StoreState } from '../index';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';
import { HOOK_RUNNING_TTL_MS, isHookRunning, pickStashedRepresentativeSurface, resolveRemoteAgent } from './fleet';

/** One detected agent session, kept attached to the terminal surface that owns it. */
export interface WorkspaceAgentRosterRow {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  ptyId: string;
  agentName: string;
  /**
   * #1481 — the agent kind for the row's identity glyph: the detector's slug
   * when it reported one, else derived from the display name. Undefined for an
   * unknown kind or a plain shell (the glyph falls back to a terminal mark).
   */
  slug?: string;
  paneName: string;
  surfaceTitle?: string;
  surfaceIndex: number;
  surfaceCount: number;
  status: AgentStatus;
  attentionStatus?: AgentStatus;
  pendingQuestion?: string;
  /**
   * #1176 — the user focused the pane while THIS question was showing. The dot
   * stays red (still blocked) but the roster drops the animated glow: triaged
   * vs untriaged blocked agents at a glance. Undefined when there is no live
   * question or it has not been seen.
   */
  questionSeen?: boolean;
  /**
   * #1163 — this row is an agent session running on a REMOTE host, mirrored
   * into this workspace as a remote-terminal surface. `ptyId` is then the
   * synthetic `remote:{hostId}:{sessionId}` key (never a local ptyId), and
   * hostLabel drives the origin badge so a remote row can never be mistaken
   * for a local agent.
   */
  remote?: { hostId: string; hostLabel: string };
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

const BARE_SHELL_TITLES = new Set([
  'bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'cmd',
  'pwsh', 'powershell', 'windows powershell', 'powershell 7', 'wsl',
  // The placeholder wmux gives a new tab before the shell names itself.
  'terminal',
]);

/** True when a tab title is only a shell's name (`Bash`, `-zsh`, `pwsh.exe`). */
export function isBareShellTitle(title: string): boolean {
  // A path title (`/bin/zsh`, `C:\\Windows\\System32\\cmd.exe`) is judged by
  // its basename.
  const base = title.trim().replace(/\\/g, '/').split('/').pop() ?? '';
  const name = base.toLowerCase().replace(/^-/, '').replace(/\.exe$/, '');
  return BARE_SHELL_TITLES.has(name);
}

/**
 * The title an AGENT row may lead with. A tab still titled after the shell
 * that hosts the agent ("Bash", "Zsh") says nothing about the agent, so it is
 * dropped and the row falls back to the agent's name. Plain shell panes keep
 * their title; this is applied to agent rows only.
 */
export function agentSurfaceTitle(surface: { title?: string; titleLocked?: boolean }): string | undefined {
  const trimmed = nonEmpty(surface.title);
  // A title the user typed is theirs even if it spells a shell name.
  if (surface.titleLocked) return trimmed;
  return trimmed && !isBareShellTitle(trimmed) ? trimmed : undefined;
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

  // #1326 — default true (undefined in tests/older sessions must behave like
  // the setting was never touched): the coordinate is withheld from the
  // trailer only for panes that have no explicit label, never for one the
  // user actually set.
  const showCoordinates = state.sidebarShowPaneCoordinates !== false;

  const rows: WorkspaceAgentRosterRow[] = [];
  for (const leaf of getLeafPanes(workspace.rootPane)) {
    const paneName = paneDisplayName(
      state.paneLabel[leaf.id],
      showCoordinates ? computePaneAutoName(workspace.wsOrdinal ?? 0, leaf.ordinal ?? 0) : '',
    );

    leaf.surfaces.forEach((surface, surfaceIndex) => {
      // #1163 — a remote-terminal surface has ptyId '' by contract and is
      // invisible to every local PTY-keyed map. It gets a row iff the attached
      // mirror carries agent metadata for its session: same "only agent rows"
      // rule as local panes, counting remote agents into the same roster.
      if ((surface.surfaceType ?? 'terminal') === 'remote-terminal') {
        const hostId = surface.remoteHostId;
        const sessionId = surface.remoteSessionId;
        if (!hostId || !sessionId) return;
        // #1343 — the resolution rules (every entry on the host, never a stale
        // one) now live in fleet.ts, shared with selectFleetPanes so the
        // sidebar roster and the Fleet cards cannot disagree about which
        // remote sessions are agents.
        const remoteAgent = resolveRemoteAgent(state.remoteWorkspaces, hostId, sessionId);
        if (!remoteAgent) return;
        const status: AgentStatus = remoteAgent.status;
        rows.push({
          workspaceId,
          paneId: leaf.id,
          surfaceId: surface.id,
          ptyId: remoteAgentKey(hostId, sessionId),
          agentName: remoteAgent.agentName,
          slug: agentDisplayToSlug(remoteAgent.agentName),
          paneName,
          surfaceTitle: agentSurfaceTitle(surface),
          surfaceIndex,
          surfaceCount: leaf.surfaces.length,
          status,
          // The host snapshot has no event channel: no unseen-attention state,
          // no transcript-derived question. The status IS the whole signal.
          pendingQuestion: undefined,
          hasAttention: false,
          needsAttention: needsAttention(status),
          isFocused:
            state.activeWorkspaceId === workspaceId &&
            workspace.activePaneId === leaf.id &&
            leaf.activeSurfaceId === surface.id,
          remote: { hostId, hostLabel: remoteAgent.hostLabel },
        });
        return;
      }
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
      // The SAME derivation `selectFleetPanes` uses for the workspace dot (see
      // isHookRunning). Reading only the activity stamp made this row age a
      // quiet turn out at 120 s while the dot above it — which honours the
      // agent's open-turn latch — stayed amber: one pane, two answers.
      const hookRunning = isHookRunning({
        activityAt,
        turnOpenAt: state.surfaceTurnOpenAt?.[ptyId],
        agentClockMs: state.agentClockMs,
      });

      // Identity-only boot hydration currently seeds `running` without an
      // activity signal. Treat that synthetic value as idle until live output
      // or a hook proves the agent is working; otherwise a quiet recovered
      // pane would pulse forever and disagree with the workspace aggregate.
      const lifecycleStatus: AgentStatus =
        agent.status === 'running' && !hookRunning ? 'idle' : agent.status;

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
        hookRunning
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
        slug: agent.slug ?? agentDisplayToSlug(agent.name),
        paneName,
        surfaceTitle: agentSurfaceTitle(surface),
        surfaceIndex,
        surfaceCount: leaf.surfaces.length,
        status,
        attentionStatus,
        pendingQuestion,
        // Optional-chained like surfaceTurnOpenAt in fleet.ts: minimal test
        // states (dotRosterParity) build partial stores without this map.
        questionSeen: pendingQuestion !== undefined && state.surfaceQuestionSeen?.[ptyId] === pendingQuestion,
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
    // Which tab represents the pane in its single row — the shared #977 picker
    // (fleet.ts), so this roster and the fleet cards can never disagree about
    // the same stashed pane.
    const surface = pickStashedRepresentativeSurface(leaf, state.surfaceAgent);
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
    // Same shared derivation as the visible rows above — a stashed agent is
    // off-screen, not exempt from the latch.
    const hookRunning = isHookRunning({
      activityAt,
      turnOpenAt: ptyId ? state.surfaceTurnOpenAt?.[ptyId] : undefined,
      agentClockMs: state.agentClockMs,
    });

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
        agent?.status === 'running' && !hookRunning ? 'idle' : (agent?.status ?? 'idle');
      status = attentionStatus ?? lifecycle;
      if (!attentionStatus && lifecycle === 'idle' && hookRunning) status = 'running';
    }

    rows.push({
      workspaceId,
      paneId: leaf.id,
      surfaceId: surface.id,
      ptyId,
      agentName: agent?.name ?? '',
      slug: agent ? agent.slug ?? agentDisplayToSlug(agent.name) : undefined,
      paneName: paneDisplayName(
        state.paneLabel[leaf.id],
        showCoordinates ? computePaneAutoName(workspace.wsOrdinal ?? 0, leaf.ordinal ?? 0) : '',
      ),
      surfaceTitle: agent ? agentSurfaceTitle(surface) : nonEmpty(surface.title),
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
      a.slug !== b.slug ||
      a.paneName !== b.paneName ||
      a.surfaceTitle !== b.surfaceTitle ||
      a.surfaceIndex !== b.surfaceIndex ||
      a.surfaceCount !== b.surfaceCount ||
      a.status !== b.status ||
      a.attentionStatus !== b.attentionStatus ||
      a.pendingQuestion !== b.pendingQuestion ||
      a.questionSeen !== b.questionSeen ||
      a.activity !== b.activity ||
      a.hasAttention !== b.hasAttention ||
      a.needsAttention !== b.needsAttention ||
      a.isFocused !== b.isFocused ||
      a.stashed !== b.stashed ||
      a.stashedLiveness !== b.stashedLiveness ||
      a.stashedAt !== b.stashedAt ||
      a.remote?.hostId !== b.remote?.hostId ||
      a.remote?.hostLabel !== b.remote?.hostLabel
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
/**
 * Counts only, reference-stable (#997).
 *
 * The full projection's reference changes whenever ANY row field does — an
 * activity string, a focus flag, a status. The summary chip on the workspace
 * row draws two integers and is mounted for every workspace, so subscribing it
 * to the full projection would rerender it on every byte a terminal in that
 * workspace prints. zustand v5 dropped the equality-function argument, so the
 * memoization lives in the selector, exactly as it does above.
 */
export function createWorkspaceRosterCountsSelector(
  workspaceId: string,
): (state: StoreState) => { agentCount: number; stashedCount: number } {
  let previous: { agentCount: number; stashedCount: number } | undefined;
  return (state) => {
    const { agentCount, stashedCount } = selectWorkspaceAgentRoster(state, workspaceId);
    if (previous && previous.agentCount === agentCount && previous.stashedCount === stashedCount) {
      return previous;
    }
    previous = { agentCount, stashedCount };
    return previous;
  };
}

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

/** #1481 — one agent in the collapsed-row summary. */
export interface RosterChipAgent {
  slug?: string;
  agentName: string;
  status: AgentStatus;
}

/** #1481 — what a collapsed workspace row shows instead of a bare count. */
export interface RosterChip {
  agentCount: number;
  stashedCount: number;
  /** Every visible agent, most urgent status first, grouped by status. */
  agents: RosterChipAgent[];
  /** Agents not listed in `agents` (stashed ones); kept for the summary's count. */
  extra: number;
}

export const CHIP_MAX_GLYPHS = 3;

/** Lower = more urgent. Needs-you first, then error, running, done, idle. */
export function chipStatusRank(status: AgentStatus): number {
  switch (status) {
    case 'awaiting_input':
    case 'waiting':
      return 0;
    case 'error':
      return 1;
    case 'running':
      return 2;
    case 'complete':
      return 3;
    default:
      return 4;
  }
}

/**
 * Pure: pick the chip's agents from roster rows. Visible agents only (stashed
 * panes keep their own glyph in the summary), stable-sorted by urgency so rows
 * sharing a status sit together. The summary counts per status, so the list
 * is not capped.
 */
export function buildRosterChip(projection: WorkspaceAgentRosterProjection): RosterChip {
  const visible = projection.rows.filter((row) => !row.stashed);
  const eff = (row: WorkspaceAgentRosterRow) => (row.status === 'waiting' && !row.pendingQuestion ? 'idle' : row.status);
  const ranked = visible
    .map((row, index) => ({ row, index }))
    .sort((a, b) => chipStatusRank(eff(a.row)) - chipStatusRank(eff(b.row)) || a.index - b.index)
    // Plain waiting with no question is idle in the shared class
    // (fleetAttentionClass) — the summary must not draw it as needs you.
    .map(({ row }) => ({ slug: row.slug, agentName: row.agentName, status: row.status === 'waiting' && !row.pendingQuestion ? 'idle' as const : row.status }));
  return {
    agentCount: projection.agentCount,
    stashedCount: projection.stashedCount,
    agents: ranked,
    extra: Math.max(0, projection.agentCount - ranked.length),
  };
}

function chipsEqual(a: RosterChip, b: RosterChip): boolean {
  if (a.agentCount !== b.agentCount || a.stashedCount !== b.stashedCount || a.extra !== b.extra) return false;
  if (a.agents.length !== b.agents.length) return false;
  for (let i = 0; i < a.agents.length; i += 1) {
    const x = a.agents[i];
    const y = b.agents[i];
    if (x.slug !== y.slug || x.agentName !== y.agentName || x.status !== y.status) return false;
  }
  return true;
}

/**
 * Reference-stable chip projection for the workspace row: re-renders the row
 * only when a drawn glyph, its status or a count changes — never on terminal
 * output or activity text.
 */
export function createWorkspaceRosterChipSelector(
  workspaceId: string,
): (state: StoreState) => RosterChip {
  let previous: RosterChip | undefined;
  return (state) => {
    const next = buildRosterChip(selectWorkspaceAgentRoster(state, workspaceId));
    if (previous && chipsEqual(previous, next)) return previous;
    previous = next;
    return next;
  };
}
