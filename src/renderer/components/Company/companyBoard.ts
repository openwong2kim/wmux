// The company board's content: who holds each seat and what each seat is
// doing, read from the workspace's panes, the sidebar roster and the
// delegated-work tickets (one per A2A send, kept by main across restarts).
// Pure, so the rules are testable without the store or main.
import type { WorkLink } from '../../../shared/workLink';
import { chipStatusRank, type WorkspaceAgentRosterRow } from '../../stores/selectors/workspaceAgentRoster';
import type { FleetTicket } from '../FleetView/fleetTickets';

export interface BoardSeat {
  paneId: string;
  coordinator: boolean;
  /** An agent runs on one of the pane's terminal tabs. */
  agent: boolean;
  /** The pane's agent, the most urgent one when the pane runs several;
   *  absent while no agent runs there. */
  row?: WorkspaceAgentRosterRow;
  /** The pane's role, when one is set. */
  owns?: string;
  /** The seat's open jobs, the ones that need you first. */
  now: FleetTicket[];
  /** Jobs queued for the seat, oldest first. */
  next: FleetTicket[];
}

export interface CompanyBoard {
  /** Jobs to or from the company that wait on the owner. */
  needsYou: FleetTicket[];
  seats: BoardSeat[];
  /** Open jobs inside the company that no seat holds: sent to a pane since
   *  closed, or to no pane while several seats run an agent. */
  unseated: FleetTicket[];
  /** Open jobs the company handed to other workspaces. */
  handedOut: FleetTicket[];
  /** Finished jobs to or from the company, newest first. */
  log: FleetTicket[];
}

export const BOARD_LOG_MAX = 10;

const isOpen = (t: FleetTicket) => t.state !== 'done' && t.state !== 'failed';

/**
 * `paneIds` is every pane of the workspace in layout order, stashed ones
 * included; `agentPaneIds` the ones with an agent on any terminal tab (a
 * stashed pane's roster row reads only one tab); `rows` its roster; `tickets` every ticket as buildFleetTickets
 * orders them (needs-you first, then newest); `links` the work links they came
 * from, which say who handed each job out.
 */
export function buildCompanyBoard({ workspaceId, coordinatorPaneId, paneIds, agentPaneIds, rows, tickets, links, paneRole }: {
  workspaceId: string;
  coordinatorPaneId: string | null;
  paneIds: readonly string[];
  agentPaneIds: ReadonlySet<string>;
  rows: readonly WorkspaceAgentRosterRow[];
  tickets: readonly FleetTicket[];
  links: readonly WorkLink[];
  paneRole: Readonly<Record<string, string>>;
}): CompanyBoard {
  const rowOf = new Map<string, WorkspaceAgentRosterRow>();
  for (const row of rows) {
    // A stashed shell is listed in the roster but runs no agent.
    if (!row.agentName) continue;
    const held = rowOf.get(row.paneId);
    if (!held || chipStatusRank(row.status) < chipStatusRank(held.status)) rowOf.set(row.paneId, row);
  }
  const ordered = coordinatorPaneId && paneIds.includes(coordinatorPaneId)
    ? [coordinatorPaneId, ...paneIds.filter((id) => id !== coordinatorPaneId)]
    : paneIds;
  const seats = ordered.map((paneId): BoardSeat => {
    const row = rowOf.get(paneId);
    const owns = paneRole[paneId]?.trim();
    const agent = !!row || agentPaneIds.has(paneId);
    return { paneId, coordinator: paneId === coordinatorPaneId, agent, ...(row ? { row } : {}), ...(owns ? { owns } : {}), now: [], next: [] };
  });
  const seatOf = new Map(seats.map((seat) => [seat.paneId, seat]));
  const agentSeats = seats.filter((seat) => seat.agent);

  const fromHere = new Set(links.filter((l) => l.requester?.workspaceId === workspaceId).map((l) => l.id));
  const board: CompanyBoard = { needsYou: [], seats, unseated: [], handedOut: [], log: [] };

  for (const ticket of tickets) {
    if (ticket.origin === 'handoff') continue;
    const inside = ticket.workspaceId === workspaceId;
    if (!inside && !fromHere.has(ticket.id)) continue;
    if (!isOpen(ticket)) {
      board.log.push(ticket);
      continue;
    }
    if (ticket.state === 'needs-you') board.needsYou.push(ticket);
    if (!inside) {
      board.handedOut.push(ticket);
      continue;
    }
    // A job that names no pane belongs to the only seat with an agent.
    const seat = ticket.paneId ? seatOf.get(ticket.paneId) : agentSeats.length === 1 ? agentSeats[0] : undefined;
    if (!seat) board.unseated.push(ticket);
    else if (ticket.state === 'queued') seat.next.unshift(ticket);
    else seat.now.push(ticket);
  }
  board.log = board.log.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, BOARD_LOG_MAX);
  return board;
}
