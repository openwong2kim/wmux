import type { AgentStatus } from '../../../shared/types';
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
  surfaceType: 'terminal' | 'browser' | 'editor';
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
};

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
      const status: AgentStatus =
        attention
        ?? (isActivePane ? wsMeta?.agentStatus : undefined)
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

// Statuses that count toward the "N need you" header chip: awaiting_input is the
// precise blocked-mid-turn state; waiting means the turn ended and a fresh
// instruction is wanted. Both are "the agent is idle on you".
export function countNeedsAttention(panes: FleetPane[]): number {
  return panes.filter(
    (p) => p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting',
  ).length;
}
