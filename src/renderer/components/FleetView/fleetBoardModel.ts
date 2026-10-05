// The Fleet page's list, as pure helpers so they are testable without a DOM.
// Sections come from selectFleetBoard (the classification the sidebar and the
// fleet.triage RPC read); this file only counts, moves and picks.
import type { FleetRow } from '../../stores/selectors/fleet';
import type { InboxItem } from '../../stores/selectors/approvalInbox';

/**
 * How many agents Fleet holds: every row outside Idle, idle panes that run an
 * agent, and finished tasks waiting for review. A plain shell is listed under
 * Idle but is not an agent, so a window of shells still reads as "no agents".
 */
export function fleetAgentCount(
  groups: { needsYou: readonly FleetRow[]; finished: readonly FleetRow[]; running: readonly FleetRow[]; idle: readonly FleetRow[] },
  reviewCount: number,
): number {
  return groups.needsYou.length + groups.finished.length + groups.running.length + reviewCount
    + groups.idle.filter((row) => Boolean(row.pane.agentName)).length;
}

/** A summary chip; a chip whose value is zero or unknown is not drawn. */
export interface BoardChip {
  id: string;
  count?: number;
  text?: string;
}

export function visibleChips(chips: readonly BoardChip[]): BoardChip[] {
  return chips.filter((chip) => (chip.count !== undefined ? chip.count > 0 : Boolean(chip.text)));
}

export type ListMove = 'up' | 'down' | 'home' | 'end';

/** Where a key press moves the selection in the list (clamped at the ends). */
export function moveInList(keys: readonly string[], current: string | null, move: ListMove): string | null {
  if (keys.length === 0) return null;
  if (move === 'home') return keys[0];
  if (move === 'end') return keys[keys.length - 1];
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return keys[0];
  const next = move === 'down' ? Math.min(at + 1, keys.length - 1) : Math.max(at - 1, 0);
  return keys[next];
}

/**
 * The Approvals row that `a` on a Fleet row points at: the first A2A execute
 * request sent to or from that row's workspace, as an index into the inbox;
 * -1 when there is none. Only A2A requests are tied to a workspace, so an MCP
 * grant (critical or not) or a browser help request never matches. `a` only
 * brings that row forward — the user reads it and approves on the Approvals
 * tab; no key on the list grants anything.
 */
export function rowApprovalIndex(inbox: readonly InboxItem[], workspaceId: string): number {
  return inbox.findIndex((it) => it.source === 'a2a'
    && (it.receiverWorkspaceId === workspaceId || it.senderWorkspaceId === workspaceId));
}
