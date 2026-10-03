// The Fleet page as a four-column attention board. Pure: the view derives its
// columns, layout and key moves here so they are testable without a DOM.
// The board reads the same classification as the sidebar and the fleet.triage
// RPC (fleetAttentionClass, through selectFleetBoard's sections); it only
// splits finished panes out of "needs you" into their own column.
import { fleetAttentionClass, type FleetRow } from '../../stores/selectors/fleet';
import type { ReviewQueueEntry } from '../../stores/selectors/reviewQueue';

export type BoardColumn = 'needsYou' | 'running' | 'review' | 'idle';
export const BOARD_COLUMNS: readonly BoardColumn[] = ['needsYou', 'running', 'review', 'idle'];

export type BoardItem =
  | { kind: 'pane'; key: string; row: FleetRow }
  | { kind: 'review'; key: string; entry: ReviewQueueEntry };

/** The board column of a Fleet row: its section, with finished panes split out. */
export function boardColumnOf(row: FleetRow): BoardColumn {
  if (row.section === 'running') return 'running';
  if (row.section === 'idle') return 'idle';
  return fleetAttentionClass(row.pane) === 'finished' ? 'review' : 'needsYou';
}

/**
 * Fill the four columns. Rows keep their selector order. A finished task is
 * shown once, as its review entry: its finished panes are not repeated.
 */
export function buildBoardColumns(
  groups: { needsYou: FleetRow[]; running: FleetRow[]; idle: FleetRow[] },
  review: readonly ReviewQueueEntry[],
  reviewKey: (workspaceId: string) => string,
): Record<BoardColumn, BoardItem[]> {
  const reviewWorkspaces = new Set(review.map((entry) => entry.workspaceId));
  const out: Record<BoardColumn, BoardItem[]> = {
    needsYou: [],
    running: [],
    review: review.map((entry) => ({ kind: 'review', key: reviewKey(entry.workspaceId), entry })),
    idle: [],
  };
  for (const row of [...groups.needsYou, ...groups.running, ...groups.idle]) {
    const column = boardColumnOf(row);
    if (column === 'review' && reviewWorkspaces.has(row.pane.workspaceId)) continue;
    out[column].push({ kind: 'pane', key: row.pane.paneId, row });
  }
  return out;
}

/**
 * How many agents the board holds: every card outside Idle, and idle panes
 * that run an agent. A plain shell is listed under Idle but is not an agent,
 * so a window of shells still reads as "no agents running".
 */
export function boardAgentCount(columns: Record<BoardColumn, BoardItem[]>): number {
  const busy = columns.needsYou.length + columns.running.length + columns.review.length;
  return busy + columns.idle.filter((item) => item.kind === 'pane' && Boolean(item.row.pane.agentName)).length;
}

export type BoardLayout = 'empty' | 'list' | 'board' | 'dense';

/** Nothing → a call to action; up to 3 → one list; 20 or more → compact cards. */
export function boardLayout(count: number): BoardLayout {
  if (count === 0) return 'empty';
  if (count <= 3) return 'list';
  return count >= 20 ? 'dense' : 'board';
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

/** A run of cards in one column: the first, and the same mission's others folded under it. */
export interface BoardGroup {
  lead: BoardItem;
  folded: BoardItem[];
  owner?: string;
}

/**
 * Fold cards that belong to the same mission (one owner) under the first of
 * them, in order of first appearance. Cards with no owner stand alone.
 */
export function foldByOwner(items: readonly BoardItem[], ownerOf: (item: BoardItem) => string | undefined): BoardGroup[] {
  const groups: BoardGroup[] = [];
  const byOwner = new Map<string, BoardGroup>();
  for (const item of items) {
    const owner = ownerOf(item);
    const existing = owner ? byOwner.get(owner) : undefined;
    if (existing) {
      existing.folded.push(item);
      continue;
    }
    const group: BoardGroup = { lead: item, folded: [], ...(owner ? { owner } : {}) };
    groups.push(group);
    if (owner) byOwner.set(owner, group);
  }
  return groups;
}

/** Keys of the focusable items, column by column, in display order. */
export type BoardGrid = Record<BoardColumn, string[]>;

export type BoardMove = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 1 | 2 | 3 | 4;

/**
 * Where a key press moves focus. ↑↓ stay in a column, ←→ go to the nearest
 * non-empty neighbour column at the same row (clamped), 1–4 go to the top of
 * that column (if it has anything). Returns the current key when nothing moves.
 */
export function moveOnBoard(grid: BoardGrid, current: string | null, move: BoardMove): string | null {
  const columns = BOARD_COLUMNS.filter((c) => grid[c].length > 0);
  if (columns.length === 0) return null;
  if (typeof move === 'number') {
    const target = BOARD_COLUMNS[move - 1];
    return grid[target].length > 0 ? grid[target][0] : current;
  }
  const found = columns.find((c) => current !== null && grid[c].includes(current));
  // Nothing focused yet (or it left the board): any move lands on the first card.
  if (!found) return grid[columns[0]][0];
  let col: typeof found = found;
  let row = grid[col].indexOf(current as string);
  if (move === 'up') row = Math.max(0, row - 1);
  else if (move === 'down') row = Math.min(grid[col].length - 1, row + 1);
  else if (move === 'home') row = 0;
  else if (move === 'end') row = grid[col].length - 1;
  else {
    const at = columns.indexOf(col);
    const next = columns[at + (move === 'right' ? 1 : -1)];
    if (!next) return grid[col][row] ?? current;
    col = next;
    row = Math.min(row, grid[col].length - 1);
  }
  return grid[col][row] ?? current;
}
