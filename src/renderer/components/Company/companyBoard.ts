// The company board's content: who holds each seat and what each seat is
// doing, read from the workspace's panes, the sidebar roster, the
// delegated-work tickets (one per A2A send, kept by main across restarts),
// and the CEO pane's links and asks to other PCs.
// Pure, so the rules are testable without the store or main.
import type { WorkLink } from '../../../shared/workLink';
import type { A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import { remoteWorkspaceId } from '../../../shared/a2aRemoteDelivery';
import type { A2aSpawnCode, A2aSpawnOutgoingSummary } from '../../../shared/a2aSpawn';
import type { AgentSlug } from '../../../shared/agentIdentity';
import type { A2aRemoteHostStatus } from '../../../shared/rpc';
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

/**
 * A seat on another PC: a link from the CEO pane to a pane there that this
 * side may send work over. Nothing is stored for it; a link that ends drops
 * the seat.
 */
export interface RemoteSeat {
  linkId: string;
  /** The link's remote label, else the pane part of its alias. */
  name: string;
  /** This PC's name for that PC. */
  pc: string;
}

export interface BoardRemoteSeat extends RemoteSeat {
  /** The seat's open jobs, the ones that need you first. */
  now: FleetTicket[];
  /** Jobs queued for the seat, oldest first. */
  next: FleetTicket[];
}

/**
 * An ask the CEO pane made for a seat on another PC: open (`pending`), or
 * answered with anything but started within the last day (`ended`, with
 * why). A started one is a seat by then.
 */
export interface BoardSeatAsk {
  spawnId: string;
  /** The name it was asked with; absent from an older ask. */
  label?: string;
  agent: AgentSlug;
  pc: string;
  /** That PC is connected now. */
  online: boolean;
  pending: boolean;
  /** Why it ended (`ended` only). */
  code?: A2aSpawnCode;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** How long an ask that ended without a seat stays on the board. */
export const ENDED_ASK_SHOWN_MS = 24 * 60 * 60 * 1000;

/** The name a paired PC goes by here; the alias's PC part when it has none. */
function pcNameOf(hosts: readonly Pick<A2aRemoteHostStatus, 'hostId' | 'name'>[], hostId: string, fallback?: string): string {
  return hosts.find((h) => h.hostId === hostId)?.name?.trim() || fallback?.trim() || hostId.slice(0, 8);
}

/**
 * The company's seats on other PCs: active links whose local end is the CEO
 * pane, with a pane at the other end and sending allowed from this side.
 */
export function remoteSeatsOf({ workspaceId, coordinatorPaneId, links, hosts }: {
  workspaceId: string;
  coordinatorPaneId: string | null;
  links: readonly A2aLinkRecordV1[];
  hosts: readonly Pick<A2aRemoteHostStatus, 'hostId' | 'name'>[];
}): RemoteSeat[] {
  if (!coordinatorPaneId) return [];
  return links
    .filter((l) => l.state === 'active' && l.allow.outbound
      && l.local.kind === 'pane' && l.local.workspaceId === workspaceId && l.local.paneId === coordinatorPaneId
      && l.remote.kind === 'pane')
    .map((l) => ({
      linkId: l.linkId,
      name: l.remote.label?.trim() || l.remote.paneId || '',
      pc: pcNameOf(hosts, l.remote.hostId),
    }));
}

/**
 * The asks the CEO pane made for a seat on another PC that the board still
 * shows: open ones, and ones that ended without a seat in the last day,
 * newest first.
 */
export function seatAsksOf({ workspaceId, coordinatorPaneId, requests, hosts, now }: {
  workspaceId: string;
  coordinatorPaneId: string | null;
  requests: readonly A2aSpawnOutgoingSummary[];
  hosts: readonly Pick<A2aRemoteHostStatus, 'hostId' | 'name' | 'state'>[];
  now: number;
}): BoardSeatAsk[] {
  if (!coordinatorPaneId) return [];
  const out: BoardSeatAsk[] = [];
  for (const r of requests) {
    if (r.from.workspaceId !== workspaceId || r.from.paneId !== coordinatorPaneId || r.state === 'started') continue;
    const pending = r.state === 'sent' || r.state === 'waiting';
    const updatedAt = Date.parse(r.updatedAt);
    if (!pending && !(now - updatedAt < ENDED_ASK_SHOWN_MS)) continue;
    // An ask that ran out of time here carries no code of its own.
    const code: A2aSpawnCode = r.code ?? (r.state === 'expired' ? 'expired' : 'failed');
    out.push({
      spawnId: r.spawnId,
      ...(r.label ? { label: r.label } : {}),
      agent: r.agent,
      pc: pcNameOf(hosts, r.hostId, r.hostName),
      online: hosts.some((h) => h.hostId === r.hostId && h.state === 'connected'),
      pending,
      ...(pending ? {} : { code }),
      createdAt: Date.parse(r.createdAt),
      updatedAt,
      expiresAt: Date.parse(r.expiresAt),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export interface CompanyBoard {
  /** Jobs to or from the company that wait on the owner. */
  needsYou: FleetTicket[];
  seats: BoardSeat[];
  /** Seats on other PCs, after the panes; their jobs leave Handed out. */
  remoteSeats: BoardRemoteSeat[];
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
 * from, which say who handed each job out; `remoteSeats` the company's seats
 * on other PCs (remoteSeatsOf).
 */
export function buildCompanyBoard({ workspaceId, coordinatorPaneId, paneIds, agentPaneIds, rows, tickets, links, paneRole, remoteSeats = [] }: {
  workspaceId: string;
  coordinatorPaneId: string | null;
  paneIds: readonly string[];
  agentPaneIds: ReadonlySet<string>;
  rows: readonly WorkspaceAgentRosterRow[];
  tickets: readonly FleetTicket[];
  links: readonly WorkLink[];
  paneRole: Readonly<Record<string, string>>;
  remoteSeats?: readonly RemoteSeat[];
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

  // A job sent over a seat's link names it as its workspace (`remote:<linkId>`).
  const remote = remoteSeats.map((seat): BoardRemoteSeat => ({ ...seat, now: [], next: [] }));
  const remoteSeatOf = new Map(remote.map((seat) => [remoteWorkspaceId(seat.linkId), seat]));

  const fromHere = new Set(links.filter((l) => l.requester?.workspaceId === workspaceId).map((l) => l.id));
  const board: CompanyBoard = { needsYou: [], seats, remoteSeats: remote, unseated: [], handedOut: [], log: [] };

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
      const remoteSeat = remoteSeatOf.get(ticket.workspaceId);
      if (!remoteSeat) board.handedOut.push(ticket);
      else if (ticket.state === 'queued') remoteSeat.next.unshift(ticket);
      else remoteSeat.now.push(ticket);
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
