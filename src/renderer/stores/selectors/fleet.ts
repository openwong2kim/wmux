import type { AgentStatus, Task } from '../../../shared/types';
import { getLeafPanes } from '../../../shared/paneUtils';
import type { StoreState } from '../index';

// ─── S-C1 Fleet View — derived "all agents, all workspaces" model ────────────
//
// Pure derivation over `state.workspaces`. Every workspace is eagerly loaded
// with its full pane tree (workspaceSlice.loadSession sets
// `state.workspaces = data.workspaces`), so background workspaces are complete
// data structures — just unrendered. There is therefore no daemon round-trip
// and no dedicated `fleetSlice`: duplicating the tree into a second store would
// only invite staleness. Fleet View adds a UI flag (uiSlice) and this selector.

export interface FleetPane {
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  surfaceId: string;
  /** Active surface's PTY id. '' when the surface has not spawned a PTY yet. */
  ptyId: string;
  agentStatus: AgentStatus;
  /** Only populated for the workspace's ACTIVE pane — see status fidelity note. */
  agentName?: string;
  /** P2 — the user's pane rename (paneLabel mirror), if any. The card's
   *  displayName prefers this so a rename shows in the cockpit too; undefined
   *  falls back to agentName/title. */
  paneLabel?: string;
  cwd?: string;
  title: string;
  surfaceType: 'terminal' | 'browser' | 'editor' | 'diff';
  /** True when this leaf is its workspace's active pane (badge fidelity hint). */
  isActivePane: boolean;
  /**
   * Hook-driven activity line for the active surface's PTY (fleet-activity-line
   * -hook.md). Sourced from the per-ptyId `surfaceActivity` map (PostToolUse →
   * summarizeActivity → throttled in main). Present only for panes whose agent
   * emits PostToolUse hooks; FleetCard falls back to the raw scrollback tail
   * when absent. Reflects the most recent FINISHED tool, not the live one.
   */
  activity?: string;
  /**
   * X8 supervision mirror for this pane's active-surface PTY, from the per-ptyId
   * `supervisionByPtyId` slice (daemon PaneSupervisor sticky status + restart
   * count). Undefined when the pane is unsupervised. Lets the cockpit show that
   * a declared/unattended agent is armed (and how many times it has restarted)
   * or that its runaway guard tripped (`stopped` — the supervisor gave up and a
   * human is needed).
   */
  supervision?: { status: 'armed' | 'stopped'; restartCount: number };
}

/** Minimal store surface the selector reads — keeps the fixture trivial and the
 *  subscription narrow (the FleetView memoizes on exactly these fields). */
export type FleetSelectorState = Pick<StoreState, 'workspaces' | 'surfaceAgentStatus' | 'surfaceActivity'> & {
  /** P2 — pane rename mirror. Optional so existing fixtures stay terse; the
   *  live FleetView always passes the real map. */
  paneLabel?: StoreState['paneLabel'];
  /** X8 supervision mirror (per-ptyId). Optional so existing fixtures stay
   *  terse; the live FleetView always passes the real map. */
  supervisionByPtyId?: StoreState['supervisionByPtyId'];
  /** Hook-driven 'running' inputs (orca-style). Both optional so existing
   *  fixtures/tests get the pre-existing behavior (no hook-freshness); the live
   *  store always provides them. `agentClockMs` is the read-time clock so a
   *  stale stamp decays without a new event (bumped by useAgentActivityClock). */
  surfaceActivityAt?: StoreState['surfaceActivityAt'];
  agentClockMs?: StoreState['agentClockMs'];
};

/**
 * How long after a pane's last PostToolUse hook it still counts as 'running'
 * with no further signal. Generous on purpose (orca uses a 30-min safety net):
 * a real Claude turn ends via the Stop hook → 'complete' (an attention status
 * that outranks this), so this window only governs the "agent is thinking
 * between tools / a hook-less agent is working" case. Long enough to survive a
 * quiet reasoning gap or a multi-second tool, short enough that a crashed agent
 * (no Stop) settles to idle promptly.
 */
export const HOOK_RUNNING_TTL_MS = 120_000;

// Priority of each status for "which one wants the user most". Lower = more
// urgent. Drives both the per-leaf attention scan (a background tab can be
// awaiting_input while the active tab is idle) and the grid sort.
const STATUS_RANK: Record<AgentStatus, number> = {
  awaiting_input: 0,
  waiting: 1,
  error: 2,
  complete: 3,
  running: 4,
  idle: 5,
};

/**
 * Status fidelity (S-C1 v1, confirmed scope):
 * `surfaceAgentStatus` only retains the ATTENTION statuses
 * (complete / waiting / awaiting_input) keyed per-ptyId — see paneSlice
 * ATTENTION_STATUSES. `running` / `idle` / `error` are *deleted* from that map,
 * so they are not available per background pane. Resolution order:
 *   1. surfaceAgentStatus[ptyId]  — accurate for attention states everywhere
 *   2. ws.metadata.agentStatus    — workspace-level, only valid for the ACTIVE pane
 *   3. 'idle'                      — default
 * `agentName` is likewise workspace-level (active-pane-derived), so it is
 * exposed only for the active pane to avoid mislabeling background panes.
 */
export function selectFleetPanes(state: FleetSelectorState): FleetPane[] {
  const result: FleetPane[] = [];
  for (const ws of state.workspaces) {
    const wsMeta = ws.metadata;
    for (const leaf of getLeafPanes(ws.rootPane)) {
      const surf = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId) ?? leaf.surfaces[0];
      const ptyId = surf?.ptyId ?? '';
      const isActivePane = ws.activePaneId === leaf.id;
      // Surface the most-urgent attention status across ANY of the leaf's
      // surfaces (a background TAB can be awaiting_input while the active tab
      // is idle), so a multi-tab pane that needs the user is never silently
      // shown as idle. The card otherwise stays keyed on the active surface.
      let attention: AgentStatus | undefined;
      for (const s of leaf.surfaces) {
        const st = s.ptyId ? state.surfaceAgentStatus[s.ptyId] : undefined;
        if (st && (attention === undefined || STATUS_RANK[st] < STATUS_RANK[attention])) {
          attention = st;
        }
      }
      // Resolution order (most → least authoritative):
      //   1. a retained ATTENTION status on any surface (waiting/complete/…)
      //   2. the active pane's workspace-level status, when it's a live non-idle
      //      state (e.g. detector/byte 'running')
      //   3. hook-driven 'running' — a PostToolUse fired within the TTL, so the
      //      agent is working even if the terminal is quiet (fixes "thinking
      //      mid-turn read as idle"; also lights BACKGROUND running panes, which
      //      never reached workspace metadata). Uses the in-state clock so it
      //      decays on its own. Absent inputs → skipped (legacy behavior).
      //   4. idle.
      const metaStatus = isActivePane ? wsMeta?.agentStatus : undefined;
      const activityAt = ptyId ? state.surfaceActivityAt?.[ptyId] : undefined;
      const hookRunning =
        activityAt !== undefined &&
        state.agentClockMs !== undefined &&
        state.agentClockMs - activityAt <= HOOK_RUNNING_TTL_MS;
      const status: AgentStatus =
        attention
        ?? (metaStatus && metaStatus !== 'idle' ? metaStatus : undefined)
        ?? (hookRunning ? 'running' : undefined)
        ?? 'idle';
      result.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        paneId: leaf.id,
        surfaceId: surf?.id ?? '',
        ptyId,
        agentStatus: status,
        agentName: isActivePane ? wsMeta?.agentName : undefined,
        paneLabel: state.paneLabel?.[leaf.id],
        cwd: surf?.cwd,
        title: surf?.title ?? '',
        surfaceType: surf?.surfaceType ?? 'terminal',
        isActivePane,
        // Per-ptyId activity line for the active surface (keyed like the card
        // itself). Undefined when the agent emits no PostToolUse hook — the
        // card then shows the raw tail. Empty ptyId never has an entry.
        activity: ptyId ? state.surfaceActivity[ptyId] : undefined,
        // X8 supervision mirror for the active surface's PTY (same key as the
        // pane badge). Only supervised panes have an entry; unsupervised →
        // undefined. An unspawned surface (empty ptyId) never carries one.
        supervision: ptyId ? state.supervisionByPtyId?.[ptyId] : undefined,
      });
    }
  }
  return result;
}

/** Situational sort mode for the cockpit grid (uiSlice.fleetSortMode). */
export type FleetSortMode = 'attention' | 'workspace';

// Sort order for the cockpit grid — two situational modes:
//   - 'attention' (default): the agents that want the user float to the top
//     (awaiting_input first — the unattended-loop money state, via STATUS_RANK
//     above), idle terminals sink. WITHIN a status tier, panes keep the
//     selector's emission order, which is `state.workspaces` (sidebar) order
//     then leaf order.
//   - 'workspace': mirror the sidebar exactly — pure workspace+leaf order,
//     status ignored. For users who navigate the fleet spatially.
//
// Both break ties by the original index (selector order == sidebar order), NOT
// by workspaceName/title: the old alphabetical localeCompare reordered the grid
// away from the sidebar, which read as "the fleet is in the wrong order". The
// index tie-break is explicit (no reliance on Array.sort stability).
export function sortFleetPanes(
  panes: FleetPane[],
  mode: FleetSortMode = 'attention',
): FleetPane[] {
  return panes
    .map((pane, index) => ({ pane, index }))
    .sort((a, b) => {
      if (mode === 'attention') {
        const r = STATUS_RANK[a.pane.agentStatus] - STATUS_RANK[b.pane.agentStatus];
        if (r !== 0) return r;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.pane);
}

// ─── NB3 trust surface — completion-evidence badge source ────────────────────
//
// The Fleet cockpit's promise is "trust an agent to run unattended". Completion
// evidence (§6.M) is the durable proof an agent left when it finished a
// delegated A2A task; surfacing it on the card is what makes that trust
// legible. This selector answers, per card, "what is the most recent COMPLETED
// A2A task addressed to this pane that carries evidence?" — read straight off
// the existing a2aTasks store (no new store/RPC).
//
// It returns the STORE's own Task reference (never a fresh object) so a
// card-local `useStore` subscription stays reference-stable across unrelated
// store writes: Object.is holds when the winning task is unchanged, so the
// memoized FleetCard does not re-render on every a2a mutation — only when THIS
// pane's latest evidence task actually changes. The card derives the display
// counts from the returned task (see FleetCardEvidenceBadge).
//
// Addressing mirrors the selector's active-pane fidelity rule for `agentName`:
// a pane-pinned task (to.paneId) matches only that exact pane; a workspace-only
// task matches the workspace's ACTIVE pane, so a ws-level completion is not
// duplicated across background sibling panes.
export function selectLatestCompletionEvidenceTask(
  a2aTasks: Record<string, Task>,
  workspaceId: string,
  paneId: string,
  isActivePane: boolean,
): Task | undefined {
  let best: Task | undefined;
  for (const task of Object.values(a2aTasks)) {
    if (task.status.state !== 'completed') continue;
    const evidence = task.status.evidence;
    if (!evidence || evidence.items.length === 0) continue;
    const to = task.metadata.to;
    if (to.workspaceId !== workspaceId) continue;
    // Pane precision: a pinned receiver pane must BE this card; an unpinned
    // (ws-only) task lands on the active pane only.
    if (to.paneId ? to.paneId !== paneId : !isActivePane) continue;
    // "Most recent" = latest completion timestamp (status.timestamp is stamped
    // at the completed transition). Lexicographic compare is chronological for
    // canonical ISO-8601 UTC strings (both produced by isoNow()).
    if (!best || task.status.timestamp > best.status.timestamp) best = task;
  }
  return best;
}

// Statuses that count toward the "N need you" header chip: awaiting_input is the
// precise blocked-mid-turn state; waiting means the turn ended and a fresh
// instruction is wanted. Both are "the agent is idle on you".
export function countNeedsAttention(panes: FleetPane[]): number {
  return panes.filter(
    (p) => p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting',
  ).length;
}

// ─── Per-workspace status roll-up — the sidebar dot's source ─────────────────
//
// The sidebar workspace dot must reflect the WHOLE workspace, not just its
// active pane. Reading `ws.metadata.agentStatus` directly (the old path) only
// ever saw the active pane and never self-healed, so an agent awaiting input in
// a background split, or a completed turn the user hasn't visited, left the dot
// wrong. This rolls the same per-surface attention scan `selectFleetPanes`
// already does (used by the deck Fleet roster + titlebar vitals) down to a
// single most-urgent status per workspace, via the shared STATUS_RANK.
//
// Returns 'idle' for a workspace with no panes or all-idle panes, so the caller
// renders the neutral dot exactly as before for quiet workspaces.
export function selectWorkspaceAgentStatus(
  state: FleetSelectorState,
  workspaceId: string,
): AgentStatus {
  let best: AgentStatus = 'idle';
  for (const pane of selectFleetPanes(state)) {
    if (pane.workspaceId !== workspaceId) continue;
    if (STATUS_RANK[pane.agentStatus] < STATUS_RANK[best]) best = pane.agentStatus;
  }
  return best;
}

/**
 * All-workspaces variant — one `selectFleetPanes` pass rolled up to a
 * `{ workspaceId → most-urgent status }` map. For loop renderers (MiniSidebar)
 * that would otherwise call the single-workspace version O(N) times, each a
 * fresh full scan. Workspaces with no non-idle pane are omitted; the caller
 * defaults a missing entry to 'idle'.
 */
export function selectAllWorkspaceAgentStatus(
  state: FleetSelectorState,
): Record<string, AgentStatus> {
  const out: Record<string, AgentStatus> = {};
  for (const pane of selectFleetPanes(state)) {
    const cur = out[pane.workspaceId] ?? 'idle';
    if (STATUS_RANK[pane.agentStatus] < STATUS_RANK[cur]) out[pane.workspaceId] = pane.agentStatus;
  }
  return out;
}
