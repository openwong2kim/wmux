// The Fleet page's list and its board layout, as pure helpers so they are
// testable without a DOM. Sections come from selectFleetBoard (the
// classification the sidebar and the fleet.triage RPC read); this file only
// counts, moves and picks.
import type { FleetRow } from '../../stores/selectors/fleet';
import type { InboxItem } from '../../stores/selectors/approvalInbox';
import type { ReviewQueueEntry } from '../../stores/selectors/reviewQueue';
import type { HandOutEntry } from '../../../shared/handOut';
import type { FleetTicket } from './fleetTickets';

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

/** The filter chips drawn: each with its count, hidden at zero unless it is
 *  the one pressed (pressing it again shows everything). */
export function visibleFilterChips<C extends { id: string; count: number }>(chips: readonly C[], pressed: string): C[] {
  return chips.filter((chip) => chip.count > 0 || chip.id === pressed);
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

// ─── Board layout ───────────────────────────────────────────────────────────
// The same rows as the list, in four columns, after the To hand out column
// (work nobody has been given yet). A column is a list section: nothing is
// classified here, so a row sits in the column whose chip counts it.

export type BoardColumn = 'handOut' | 'needsYou' | 'running' | 'finished' | 'idle';
export const BOARD_COLUMNS: readonly BoardColumn[] = ['handOut', 'running', 'needsYou', 'finished', 'idle'];

export type BoardItem =
  | { kind: 'pane'; key: string; row: FleetRow }
  | { kind: 'review'; key: string; entry: ReviewQueueEntry }
  | { kind: 'ticket'; key: string; ticket: FleetTicket }
  | { kind: 'handOut'; key: string; item: HandOutEntry };

/** The board column of a Fleet row: its section. */
export function boardColumnOf(row: FleetRow): BoardColumn {
  return row.section;
}

/**
 * Fill the columns, each in the list's order. To hand out holds the open
 * items as given (newest first); Needs you holds its rows and the tickets
 * waiting on a decision; Finished holds the unread final reports, the Ready to
 * review tasks and the finished turns, and shows a finished task once — as
 * its review entry — rather than again as its pane.
 */
export function buildBoardColumns(
  groups: { needsYou: readonly FleetRow[]; finished: readonly FleetRow[]; running: readonly FleetRow[]; idle: readonly FleetRow[] },
  extra: { decisions: readonly FleetTicket[]; reports: readonly FleetTicket[]; review: readonly ReviewQueueEntry[]; handOut: readonly HandOutEntry[] },
  keys: { review: (workspaceId: string) => string; ticket: (ticketId: string) => string; handOut: (itemId: string) => string },
): Record<BoardColumn, BoardItem[]> {
  const pane = (row: FleetRow): BoardItem => ({ kind: 'pane', key: row.pane.paneId, row });
  const ticket = (item: FleetTicket): BoardItem => ({ kind: 'ticket', key: keys.ticket(item.id), ticket: item });
  const reviewWorkspaces = new Set(extra.review.map((entry) => entry.workspaceId));
  const out: Record<BoardColumn, BoardItem[]> = { handOut: [], needsYou: [], running: [], finished: [], idle: [] };
  out.handOut.push(...extra.handOut.map((item): BoardItem => ({ kind: 'handOut', key: keys.handOut(item.id), item })));
  for (const row of [...groups.needsYou, ...groups.running, ...groups.idle]) out[boardColumnOf(row)].push(pane(row));
  out.needsYou.push(...extra.decisions.map(ticket));
  out.finished.push(
    ...extra.reports.map(ticket),
    ...extra.review.map((entry): BoardItem => ({ kind: 'review', key: keys.review(entry.workspaceId), entry })),
    ...groups.finished.filter((row) => !reviewWorkspaces.has(row.pane.workspaceId)).map(pane),
  );
  return out;
}

/** Keys of the focusable cards, column by column, in display order. */
export type BoardGrid = Record<BoardColumn, string[]>;

export function boardGrid(columns: Record<BoardColumn, readonly BoardItem[]>): BoardGrid {
  return {
    handOut: columns.handOut.map((item) => item.key),
    needsYou: columns.needsYou.map((item) => item.key),
    running: columns.running.map((item) => item.key),
    finished: columns.finished.map((item) => item.key),
    idle: columns.idle.map((item) => item.key),
  };
}

export type BoardMove = ListMove | 'left' | 'right';

/**
 * Where a key press moves focus on the board. ↑↓ stay in a column (clamped),
 * Home/End go to its ends, ←→ go to the nearest non-empty neighbour column at
 * the same row (clamped to its length). Nothing focused yet, or a key that
 * left the board, lands on the first card.
 */
export function moveOnBoard(grid: BoardGrid, current: string | null, move: BoardMove): string | null {
  const columns = BOARD_COLUMNS.filter((c) => grid[c].length > 0);
  if (columns.length === 0) return null;
  const col = columns.find((c) => current !== null && grid[c].includes(current));
  if (!col) return grid[columns[0]][0];
  const keys = grid[col];
  const row = keys.indexOf(current as string);
  if (move === 'up') return keys[Math.max(0, row - 1)];
  if (move === 'down') return keys[Math.min(keys.length - 1, row + 1)];
  if (move === 'home') return keys[0];
  if (move === 'end') return keys[keys.length - 1];
  const next = columns[columns.indexOf(col) + (move === 'right' ? 1 : -1)];
  if (!next) return current;
  return grid[next][Math.min(row, grid[next].length - 1)];
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
