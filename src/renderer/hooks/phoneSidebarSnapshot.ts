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
//   - pane group:   `splitTasksByPane` over the owner's leaves, the split
//                   the sidebar files each nested task under (#1581)
//   - panes:        the roster's pane display name and surface title rules
//   - layout:       `rootPane` as PaneContainer draws it (direction, sizes,
//                   tab order, active tab) and `activePaneId`
//   - HQ / moa:     `state.moa` (main's Moa state), as `isMoaHqWorkspace`
//                   reads it
//   - moaWakeBlocked: the HQ workspace's agent mode (DECK_MODE_GET), passed
//                   in by the caller: `off` refuses every brain turn there
//   - moaHandoff:   main's pending decisions (DECK_MOA_DECISIONS), passed in
//                   by the caller: a pending hand-off card in that slot
//   - moaDelegations: Fleet's own tickets (`buildFleetTickets` over main's
//                   WorkLinks, passed in, the same decisions and the A2A
//                   mirror), the Moa-origin ones only; a pane's prompt from
//                   `surfaceAttentionStatus`
//
// Store-free (state in, plain object out) so it is unit-testable directly.

import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { isBrainPtyId } from '../../shared/constants';
import { moaHqId } from '../stores/slices/moaSlice';
import {
  PHONE_LAYOUT_SURFACE_KINDS,
  PHONE_SIDEBAR_LIMITS,
  clampSidebarString,
  equalLayoutSizes,
  isSidebarId,
  normalizeLayoutSizes,
  type PhoneLayoutNode,
  type PhoneLayoutSurface,
  type PhoneLayoutSurfaceKind,
  type PhoneSidebarLayout,
  type PhoneSidebarMoaHandoff,
  type PhoneMoaDelegation,
  type PhoneMoaDelegationState,
  PHONE_MOA_DELEGATION_RECENT_MS,
  type PhoneSidebarPane,
  type PhoneSidebarSnapshot,
  type PhoneSidebarWorkspace,
  type PhoneFleetTicket,
  type SidebarDropReporter,
} from '../../shared/phoneFleetSidebar';
import {
  PHONE_FLEET_TICKET_DETAIL_LIMITS,
  PHONE_FLEET_TICKET_DETAILS_KEY,
  clampTicketText,
  firstTicketLine,
  type PhoneFleetTicketDetail,
  type PhoneFleetTicketVerificationItem,
} from '../../shared/phoneFleetTickets';
import { selectScheduleNavSummary } from '../stores/selectors/schedules';
import type { Pane, Surface } from '../../shared/types';
import type { MoaPendingDecision } from '../../shared/moa';
import { HANDOFF_OPTIONS } from '../../shared/moaHandoff';
import type { StoreState } from '../stores';
import { resolveTaskLink } from '../utils/fanoutProvenance';
import { computePaneAutoName, paneDisplayName } from '../utils/paneNaming';
import { buildSidebarTree, paneRowsFinished, splitTasksByPane, taskRollup } from '../components/Sidebar/sidebarTree';
import { selectWorkspaceAgentStatus, surfaceAttentionStatus } from '../stores/selectors/fleet';
import { selectWorkspaceAgentRoster, agentSurfaceTitle } from '../stores/selectors/workspaceAgentRoster';
import { isTaskReadyForReview } from '../stores/selectors/reviewQueue';
import { buildFleetTickets, type FleetTicket } from '../components/FleetView/fleetTickets';
import type { WorkLink } from '../../shared/workLink';
import type { AgentMode } from '../../main/deck/deckAutonomyStore';
import { agentSlugToDisplay, isAgentSlug } from '../../shared/agentIdentity';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The workspace's visible split tree, walked from `rootPane` — never
 * `getWorkspaceLeafPanes`, which also returns stashed panes the desktop does
 * not draw. Undefined when the tree is over a bound, so the phone gets the
 * flat list alone rather than a tree the parsers would refuse.
 */
function projectLayout(ws: StoreState['workspaces'][number]): PhoneSidebarLayout | undefined {
  const bounds = PHONE_SIDEBAR_LIMITS.layout;
  let nodes = 0;
  let leaves = 0;
  let surfaceCount = 0;
  const leafIds = new Set<string>();
  const ptyIds = new Set<string>();
  const surfaceIds = new Set<string>();

  /** Null when the tab has no usable id: a reader keys tabs by it, so the tree cannot go out. */
  const projectSurface = (surface: Surface): PhoneLayoutSurface | null => {
    const surfaceId = surface.id;
    if (!isSidebarId(surfaceId) || surfaceIds.has(surfaceId)) return null;
    surfaceIds.add(surfaceId);
    const type = surface.surfaceType ?? 'terminal';
    const kind: PhoneLayoutSurfaceKind = (PHONE_LAYOUT_SURFACE_KINDS as readonly string[]).includes(type)
      ? type as PhoneLayoutSurfaceKind
      : 'other';
    if (kind === 'terminal') {
      // Same rule as the pane rows: no brain session, and only an id the
      // parsers accept; a slot without one still holds its tab position.
      const ptyId = surface.ptyId;
      if (!isSidebarId(ptyId) || isBrainPtyId(ptyId) || ptyIds.has(ptyId)) return { surfaceId, kind };
      ptyIds.add(ptyId);
      return { surfaceId, kind, ptyId };
    }
    const title = clampSidebarString(surface.title, PHONE_SIDEBAR_LIMITS.surfaceTitle);
    return title ? { surfaceId, kind, title } : { surfaceId, kind };
  };

  const walk = (pane: Pane, depth: number): PhoneLayoutNode | null => {
    if (depth > bounds.depth || ++nodes > bounds.nodes) return null;
    if (pane.type === 'leaf') {
      if (++leaves > bounds.leaves || !isSidebarId(pane.id) || leafIds.has(pane.id) || pane.surfaces.length > bounds.surfacesPerLeaf) return null;
      surfaceCount += pane.surfaces.length;
      if (surfaceCount > bounds.surfaces) return null;
      leafIds.add(pane.id);
      const surfaces: PhoneLayoutSurface[] = [];
      for (const surface of pane.surfaces) {
        const projected = projectSurface(surface);
        if (!projected) return null;
        surfaces.push(projected);
      }
      const active = pane.surfaces.findIndex((surface) => surface.id === pane.activeSurfaceId);
      return { kind: 'leaf', paneId: pane.id, surfaces, ...(surfaces.length > 0 ? { activeIndex: Math.max(active, 0) } : {}) };
    }
    if (pane.children.length === 0 || pane.children.length > bounds.children) return null;
    const children: PhoneLayoutNode[] = [];
    for (const child of pane.children) {
      const node = walk(child, depth + 1);
      if (!node) return null;
      children.push(node);
    }
    // `sizes` is optional and may not match the children (a split mid-update):
    // the desktop then renders an equal split, and so does the phone.
    const sizes = normalizeLayoutSizes(pane.sizes, children.length) ?? equalLayoutSizes(children.length);
    return { kind: 'split', direction: pane.direction, sizes, children };
  };

  const root = walk(ws.rootPane, 1);
  if (!root) return undefined;
  return { root, ...(leafIds.has(ws.activePaneId) ? { activePaneId: ws.activePaneId } : {}) };
}

/**
 * The body's first non-blank line, made one safe line and cut to the bound;
 * the card's own title when the body has none.
 */
export function phoneHandoffTitle(body: unknown, fallback: unknown): string | undefined {
  const max = PHONE_SIDEBAR_LIMITS.moaHandoffTitle;
  if (typeof body === 'string') {
    // Look at a bounded head only: the body can be 16 KB.
    const line = body.slice(0, 4 * max).split(/\r\n|[\n\r\u0085\u2028\u2029]/).find((l) => l.trim().length > 0);
    const title = clampSidebarString(line, max);
    if (title) return title;
  }
  return typeof fallback === 'string' ? clampSidebarString(fallback, max) : undefined;
}

/**
 * Per workspace, the pending hand-off card the phone may show as a notice:
 * only a card that still offers "Hand off" (not the could-not-deliver notice),
 * the oldest when a slot somehow holds more than one. Never the body.
 */
export function pendingHandoffNotices(decisions: readonly MoaPendingDecision[] | undefined): Map<string, PhoneSidebarMoaHandoff> {
  const out = new Map<string, PhoneSidebarMoaHandoff>();
  for (const d of decisions ?? []) {
    const info = d?.handoff;
    if (!info || !isSidebarId(d.workspaceId) || !Array.isArray(d.decision?.options) || !d.decision.options.includes(HANDOFF_OPTIONS.handOff)) continue;
    const raisedAt = d.decision.raisedAt;
    if (typeof raisedAt !== 'number' || !Number.isSafeInteger(raisedAt) || raisedAt <= 0) continue;
    const agentName = clampSidebarString(info.agentName, PHONE_SIDEBAR_LIMITS.moaHandoffAgentName);
    const title = phoneHandoffTitle(info.body, info.title);
    if (!agentName || !title) continue;
    const prev = out.get(d.workspaceId);
    if (!prev || raisedAt < prev.raisedAt) out.set(d.workspaceId, { agentName, title, raisedAt });
  }
  return out;
}

/**
 * The delegated agent's PTY: the one agent tab in the named pane, or in the
 * whole workspace when no pane is named. Fleet's `openTicketFor` rule, counted
 * per agent tab: with two agent tabs in scope the job is not attributed, so
 * another tab's prompt or name never lands on it.
 */
function delegatedPty(state: StoreState, ticket: FleetTicket): string | undefined {
  const ws = state.workspaces.find((w) => w.id === ticket.workspaceId);
  if (!ws) return undefined;
  const leaves = getWorkspaceLeafPanes(ws).filter((leaf) => !ticket.paneId || leaf.id === ticket.paneId);
  const agentPtys = leaves.flatMap((leaf) => leaf.surfaces)
    .filter((surface) => (surface.surfaceType ?? 'terminal') === 'terminal' && !!surface.ptyId && !isBrainPtyId(surface.ptyId))
    .map((surface) => surface.ptyId as string)
    .filter((pty) => !!state.surfaceAgent?.[pty]?.name?.trim());
  return agentPtys.length === 1 ? agentPtys[0] : undefined;
}

/**
 * Moa's delegated jobs for the phone: Fleet's tickets with a Moa origin and
 * an A2A task, newest first, bounded. `blocked` is a pending Moa decision,
 * the task asking for input, or the delegated pane waiting on a prompt
 * (approval, permission, question). Never the request or the result.
 */
export function projectMoaDelegations(
  state: StoreState,
  links: readonly WorkLink[],
  decisions: readonly MoaPendingDecision[],
  now: number,
): PhoneMoaDelegation[] {
  const tickets = buildFleetTickets({ links, decisions, a2aTasks: state.a2aTasks ?? {}, now });
  const out: PhoneMoaDelegation[] = [];
  for (const ticket of tickets) {
    if (ticket.origin !== 'moa' && ticket.origin !== 'moa-auto') continue;
    // A link without its task is a hand-off still being delivered (or one
    // that failed to): not a job yet.
    if (!isSidebarId(ticket.a2aTaskId) || !isSidebarId(ticket.workspaceId)) continue;
    const pty = delegatedPty(state, ticket);
    const ended = ticket.state === 'done' || ticket.state === 'failed';
    if (ended && now - ticket.updatedAt > PHONE_MOA_DELEGATION_RECENT_MS) continue;
    let phoneState: PhoneMoaDelegationState;
    if (ended) phoneState = ticket.state as 'done' | 'failed';
    else if (ticket.state === 'needs-you' || (pty !== undefined && surfaceAttentionStatus(state, pty) === 'awaiting_input')) phoneState = 'blocked';
    else phoneState = 'working';
    const paneAgent = pty !== undefined ? state.surfaceAgent?.[pty]?.name : undefined;
    const agentName = clampSidebarString(
      paneAgent ?? (isAgentSlug(ticket.agent) ? agentSlugToDisplay(ticket.agent) : ticket.agent) ?? 'Agent',
      PHONE_SIDEBAR_LIMITS.moaDelegationAgentName,
    ) ?? 'Agent';
    const title = clampSidebarString(ticket.title, PHONE_SIDEBAR_LIMITS.moaDelegationTitle) ?? 'Untitled task';
    if (!Number.isSafeInteger(ticket.updatedAt) || ticket.updatedAt <= 0) continue;
    out.push({ taskId: ticket.a2aTaskId, workspaceId: ticket.workspaceId, agentName, title, state: phoneState, since: ticket.updatedAt });
  }
  return out.sort((a, b) => b.since - a.since).slice(0, PHONE_SIDEBAR_LIMITS.moaDelegations);
}

/** A finished task's evidence items, each made one safe bounded line. */
function verificationItemsOf(state: StoreState, taskId: string | undefined): PhoneFleetTicketVerificationItem[] {
  const items = taskId ? state.a2aTasks?.[taskId]?.status.evidence?.items : undefined;
  if (!Array.isArray(items)) return [];
  const max = PHONE_FLEET_TICKET_DETAIL_LIMITS.itemText;
  const out: PhoneFleetTicketVerificationItem[] = [];
  for (const item of items.slice(0, PHONE_FLEET_TICKET_DETAIL_LIMITS.items)) {
    const summary = clampSidebarString(item.summary, max);
    if (!summary) continue;
    if (item.kind === 'command') {
      const command = clampSidebarString(item.command, max);
      out.push({ kind: 'command', status: item.status, summary, ...(command ? { command } : {}) });
    } else {
      const location = clampSidebarString(item.location, max);
      out.push({ kind: item.kind, status: item.status, summary, ...(location ? { location } : {}) });
    }
  }
  return out;
}

/**
 * Every Fleet ticket for the phone, in the desktop's order (needs-you first,
 * then newest), bounded; and, for the same tickets, the full request, report
 * and evidence main keeps for the detail route. Agent-authored text is
 * projected here unconditionally: the daemon applies `--allow-transcript`.
 */
export function projectFleetTickets(
  state: StoreState,
  links: readonly WorkLink[],
  decisions: readonly MoaPendingDecision[],
  now: number,
): { tickets: PhoneFleetTicket[]; details: PhoneFleetTicketDetail[] } {
  const L = PHONE_SIDEBAR_LIMITS;
  const tickets: PhoneFleetTicket[] = [];
  const details: PhoneFleetTicketDetail[] = [];
  for (const ticket of buildFleetTickets({ links, decisions, a2aTasks: state.a2aTasks ?? {}, now })) {
    if (tickets.length >= L.fleetTickets) break;
    if (!isSidebarId(ticket.id) || !isSidebarId(ticket.workspaceId)) continue;
    if (!Number.isSafeInteger(ticket.updatedAt) || ticket.updatedAt <= 0) continue;
    // A hand-off card names its agent itself; a job names the pane's agent
    // when exactly one is in scope, else the link's slug.
    const pty = ticket.origin === 'handoff' ? undefined : delegatedPty(state, ticket);
    const paneAgent = pty !== undefined ? state.surfaceAgent?.[pty]?.name : undefined;
    const agentName = clampSidebarString(
      paneAgent ?? (isAgentSlug(ticket.agent) ? agentSlugToDisplay(ticket.agent) : ticket.agent),
      L.fleetTicketAgentName,
    );
    const workspaceName = clampSidebarString(state.workspaces.find((w) => w.id === ticket.workspaceId)?.name, L.fleetTicketWorkspaceName);
    const requestLine = firstTicketLine(ticket.request, L.fleetTicketRequestLine);
    const resultSummary = firstTicketLine(ticket.result?.summary, L.fleetTicketResultSummary);
    const verification = ticket.result?.verification;
    tickets.push({
      id: ticket.id,
      ...(isSidebarId(ticket.a2aTaskId) ? { taskId: ticket.a2aTaskId } : {}),
      origin: ticket.origin,
      workspaceId: ticket.workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      ...(agentName ? { agentName } : {}),
      title: clampSidebarString(ticket.title, L.fleetTicketTitle) ?? 'Untitled task',
      state: ticket.state,
      updatedAt: ticket.updatedAt,
      ...(requestLine ? { requestLine } : {}),
      ...(resultSummary ? { resultSummary } : {}),
      ...(verification ? { verification } : {}),
    });
    const request = clampTicketText(ticket.request);
    const result = clampTicketText(ticket.result?.summary);
    const items = verificationItemsOf(state, ticket.a2aTaskId);
    details.push({
      id: ticket.id,
      updatedAt: ticket.updatedAt,
      ...(request ? { request } : {}),
      ...(result ? { result } : {}),
      ...(verification ? { verification } : {}),
      ...(items.length > 0 ? { verificationItems: items } : {}),
    });
  }
  return { tickets, details };
}

/** The snapshot plus the ticket details main keeps and strips (never forwarded). */
export type PhoneSidebarReply = PhoneSidebarSnapshot & { [PHONE_FLEET_TICKET_DETAILS_KEY]?: PhoneFleetTicketDetail[] };

/**
 * One bad workspace, task record or pane never costs the whole snapshot: each
 * part is projected on its own, and a part that throws is left out and
 * reported to `onDrop` by a reason tag (never the value).
 */
export function buildPhoneSidebarSnapshot(
  state: StoreState,
  onDrop: SidebarDropReporter = () => undefined,
  moaDecisions?: readonly MoaPendingDecision[],
  workLinks?: { links: readonly WorkLink[]; now: number },
  hqMode?: { workspaceId: string; mode: AgentMode },
): PhoneSidebarReply {
  const workspaces = state.workspaces;
  let handoffs = new Map<string, PhoneSidebarMoaHandoff>();
  try {
    handoffs = pendingHandoffNotices(moaDecisions);
  } catch {
    onDrop('workspace.moaHandoff');
  }
  const liveIds = new Set(workspaces.map((w) => w.id));
  const linkOf = (id: string) =>
    resolveTaskLink(state.missionByPaneGroup[id], state.fanoutLineage[id], state.fanoutSpawnOwner[id]);
  // The nesting the sidebar draws: which tasks sit under which owner row.
  // Order does not change membership, so the manual order stands in for the
  // sidebar's display sort here.
  let nestedTaskIds = new Set<string>();
  let ownersWithTasks: { id: string; taskIds: string[] }[] = [];
  try {
    const tree = buildSidebarTree(workspaces, linkOf, liveIds);
    nestedTaskIds = new Set(tree.top.flatMap((node) => node.taskIds));
    ownersWithTasks = tree.top.filter((node) => node.taskIds.length > 0);
  } catch {
    // No nesting this round; every other field still goes out.
    onDrop('task.tree');
  }
  // Which of its owner's panes each nested task sits under. The pure split,
  // not the memoized `selectOwnerPaneTaskSplit`: that cache is shared with the
  // sidebar and keyed on its display order, which this manual-order walk
  // would otherwise replace on every phone poll.
  const paneGroupOf = new Map<string, { paneGroup: 'pane'; requesterPaneId: string } | { paneGroup: 'closedPane' }>();
  for (const owner of ownersWithTasks) {
    try {
      const ws = workspaces.find((w) => w.id === owner.id);
      if (!ws) continue;
      const panes = getWorkspaceLeafPanes(ws).map((leaf) => ({ paneId: leaf.id, surfaceIds: leaf.surfaces.map((surface) => surface.id) }));
      const split = splitTasksByPane(owner.taskIds, (id) => state.fanoutOrigin?.[id], panes);
      for (const [paneId, ids] of split.byPane) for (const id of ids) paneGroupOf.set(id, { paneGroup: 'pane', requesterPaneId: paneId });
      for (const id of split.closedPane) paneGroupOf.set(id, { paneGroup: 'closedPane' });
    } catch {
      // This owner's tasks go out nested without a pane group.
      onDrop('task.split');
    }
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
    try {
      const layout = projectLayout(ws);
      if (layout) row.layout = layout;
      else onDrop('workspace.layout.bounds');
    } catch {
      onDrop('workspace.layout');
    }
    const handoff = handoffs.get(ws.id);
    if (handoff) row.moaHandoff = handoff;
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
        const group = paneGroupOf.get(id);
        if (group) Object.assign(row.task, group);
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
            paneId: leaf.id,
            ...(surfaceTitle ? { surfaceTitle } : {}),
            ...(paneName ? { paneName } : {}),
          });
        }
      } catch {
        onDrop('pane.row');
      }
    }
  }

  // The Moa HQ, by the rule the desktop hides it with (`moaHqId`): the
  // designated id, Moa on or off — the remembered id until main's first
  // answer, so the phone does not show the HQ for a moment at boot. `moa`
  // only while Moa is on and main reports its workspace present.
  const hqId = moaHqId(state);
  const hqWorkspaceId = isSidebarId(hqId) ? hqId : undefined;
  // Only with main's WorkLinks and decisions both in hand: an empty list must
  // mean "no jobs", and a job must not read as working because the decision
  // blocking it could not be read.
  let moaDelegations: PhoneMoaDelegation[] | undefined;
  if (workLinks && moaDecisions) {
    try {
      moaDelegations = projectMoaDelegations(state, workLinks.links, moaDecisions, workLinks.now);
    } catch {
      onDrop('moaDelegations');
    }
  }

  // Same inputs and the same rule as moaDelegations.
  let fleet: ReturnType<typeof projectFleetTickets> | undefined;
  if (workLinks && moaDecisions) {
    try {
      fleet = projectFleetTickets(state, workLinks.links, moaDecisions, workLinks.now);
    } catch {
      onDrop('fleetTickets');
    }
  }
  let nextScheduleAt: number | undefined;
  try {
    const next = selectScheduleNavSummary(state).nextRunAt;
    if (next !== null && Number.isSafeInteger(next) && next > 0) nextScheduleAt = next;
  } catch {
    onDrop('nextScheduleAt');
  }

  const moaOn = state.moa?.config.enabled === true && state.moa.hq.state === 'ok' && hqWorkspaceId !== undefined && liveIds.has(hqWorkspaceId);
  // A wake would end 409 `moa-mode-off`: say so only for the HQ this snapshot
  // names, and only on a mode main actually answered (no read → no claim).
  const wakeBlocked = moaOn && hqMode?.workspaceId === hqWorkspaceId && hqMode.mode === 'off';

  return {
    activeWorkspaceId: state.activeWorkspaceId && liveIds.has(state.activeWorkspaceId) ? state.activeWorkspaceId : null,
    workspaces: workspaceRows,
    panes: paneRows,
    ...(hqWorkspaceId !== undefined ? { hqWorkspaceId } : {}),
    ...(moaOn ? { moa: true as const } : {}),
    ...(wakeBlocked ? { moaWakeBlocked: 'moa-mode-off' as const } : {}),
    ...(moaDelegations ? { moaDelegations } : {}),
    ...(fleet ? { fleetTickets: fleet.tickets, [PHONE_FLEET_TICKET_DETAILS_KEY]: fleet.details } : {}),
    ...(nextScheduleAt !== undefined ? { nextScheduleAt } : {}),
  };
}
