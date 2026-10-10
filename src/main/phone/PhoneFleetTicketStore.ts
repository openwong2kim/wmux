// Main's memory of each Fleet ticket's full text, for the phone's ticket
// detail. The daemon drops an ended A2A task 30 minutes after it ends, and
// with it the request and the evidence the renderer's mirror reads; a ticket
// stays listed for 24 hours. So every snapshot the phone pulls also refreshes
// this store, and a detail is answered from here.
//
// Memory only, bounded: at most PHONE_FLEET_TICKET_DETAIL_LIMITS.store
// tickets, none past the list's 24-hour window, each field already capped by
// the parser. Nothing is written to disk.

import {
  PHONE_FLEET_TICKET_DETAIL_LIMITS,
  PHONE_FLEET_TICKET_RECENT_MS,
  type PhoneFleetTicket,
  type PhoneFleetTicketDetail,
} from '../../shared/phoneFleetTickets';

interface Entry {
  detail: PhoneFleetTicketDetail;
  workspaceName?: string;
  /** Epoch ms this ticket was last in a snapshot. */
  seenAt: number;
}

export class PhoneFleetTicketStore {
  private entries = new Map<string, Entry>();

  constructor(private readonly limit: number = PHONE_FLEET_TICKET_DETAIL_LIMITS.store) {}

  /**
   * Fold one snapshot in. A field the new projection lacks keeps the value
   * already held while the ticket version (`updatedAt`) is unchanged: the
   * request and the evidence vanish from the mirror when the daemon drops the
   * task, and that must not erase them here. A new version replaces the
   * report and the evidence, but keeps the request (it does not change).
   */
  remember(tickets: readonly PhoneFleetTicket[], details: readonly PhoneFleetTicketDetail[], now: number): void {
    const byId = new Map(details.map((d) => [d.id, d]));
    for (const ticket of tickets) {
      const fresh = byId.get(ticket.id) ?? { id: ticket.id, updatedAt: ticket.updatedAt };
      const prev = this.entries.get(ticket.id);
      let detail: PhoneFleetTicketDetail = fresh;
      if (prev) {
        const kept = prev.detail.updatedAt === fresh.updatedAt ? prev.detail : { id: fresh.id, updatedAt: fresh.updatedAt, ...(prev.detail.request ? { request: prev.detail.request } : {}) };
        detail = { ...kept, ...fresh };
      }
      const workspaceName = ticket.workspaceName ?? prev?.workspaceName;
      this.entries.delete(ticket.id);
      this.entries.set(ticket.id, { detail, ...(workspaceName ? { workspaceName } : {}), seenAt: now });
    }
    this.prune(now);
  }

  /** The kept detail, or undefined (unknown, or past the window). */
  detail(id: string, now: number): PhoneFleetTicketDetail | undefined {
    this.prune(now);
    return this.entries.get(id)?.detail;
  }

  /** The list with each ticket's workspace name filled from memory once its workspace has closed. */
  withWorkspaceNames(tickets: readonly PhoneFleetTicket[]): PhoneFleetTicket[] {
    return tickets.map((ticket) => {
      if (ticket.workspaceName !== undefined) return ticket;
      const name = this.entries.get(ticket.id)?.workspaceName;
      return name ? { ...ticket, workspaceName: name } : ticket;
    });
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Past the window: a ticket not seen in a snapshot for 24 hours (the list
   * has dropped it by then, whatever its state). Over the bound: the least
   * recently seen go first.
   */
  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.seenAt > PHONE_FLEET_TICKET_RECENT_MS) this.entries.delete(id);
    }
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [id] of ordered.slice(0, Math.max(0, ordered.length - this.limit))) this.entries.delete(id);
  }
}

let shared: PhoneFleetTicketStore | null = null;

/** The process's one store, shared by the list and the detail handler. */
export function getPhoneFleetTicketStore(): PhoneFleetTicketStore {
  shared ??= new PhoneFleetTicketStore();
  return shared;
}
