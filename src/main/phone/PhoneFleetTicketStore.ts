// Main's memory of each Fleet ticket's full text, for the phone's ticket
// detail. The daemon drops an ended A2A task 30 minutes after it ends, and
// with it the request and the evidence the renderer's mirror reads; a ticket
// stays listed for 24 hours. So every snapshot the phone pulls also refreshes
// this store, and a detail is answered from here.
//
// Memory only, bounded: at most PHONE_FLEET_TICKET_DETAIL_LIMITS.store
// tickets, a finished one no longer than the list keeps it (24 hours after it
// ended), each field already capped by the parser. Nothing is written to disk.

import {
  PHONE_FLEET_TICKET_DETAIL_LIMITS,
  PHONE_FLEET_TICKET_RECENT_MS,
  type PhoneFleetTicket,
  type PhoneFleetTicketDetail,
  type PhoneFleetTicketState,
} from '../../shared/phoneFleetTickets';

interface Entry {
  detail: PhoneFleetTicketDetail;
  state: PhoneFleetTicketState;
  workspaceName?: string;
  /** Epoch ms this ticket was last in a snapshot. */
  seenAt: number;
}

/** How long an id the renderer did not know answers "not found" without asking again. */
const MISS_TTL_MS = 5000;
const MISS_LIMIT = 256;

const ended = (state: PhoneFleetTicketState) => state === 'done' || state === 'failed';

export class PhoneFleetTicketStore {
  private entries = new Map<string, Entry>();
  private misses = new Map<string, number>();

  constructor(private readonly limit: number = PHONE_FLEET_TICKET_DETAIL_LIMITS.store) {}

  /**
   * Fold one snapshot in. A snapshot older than what is held (`updatedAt`
   * went backwards) changes nothing but the last-seen time. Otherwise the
   * new projection's fields win and the held ones fill its gaps: the request
   * and the evidence vanish from the mirror when the daemon drops the task,
   * and that must not erase them here. A ticket that is not finished has no
   * report, so a reopened one drops the old one.
   */
  remember(tickets: readonly PhoneFleetTicket[], details: readonly PhoneFleetTicketDetail[], now: number): void {
    const byId = new Map(details.map((d) => [d.id, d]));
    for (const ticket of tickets) {
      this.misses.delete(ticket.id);
      const prev = this.entries.get(ticket.id);
      const workspaceName = ticket.workspaceName ?? prev?.workspaceName;
      let detail: PhoneFleetTicketDetail;
      let state = ticket.state;
      if (prev && ticket.updatedAt < prev.detail.updatedAt) {
        detail = prev.detail;
        state = prev.state;
      } else {
        const fresh = byId.get(ticket.id) ?? { id: ticket.id, updatedAt: ticket.updatedAt };
        detail = { ...(prev?.detail ?? {}), ...fresh, updatedAt: ticket.updatedAt };
        if (!ended(state)) {
          const { result: _result, verification: _verification, verificationItems: _items, ...open } = detail;
          detail = open;
        }
      }
      this.entries.delete(ticket.id);
      this.entries.set(ticket.id, { detail, state, ...(workspaceName ? { workspaceName } : {}), seenAt: now });
    }
    this.prune(now);
  }

  /** The kept detail, or undefined (unknown, or past the list's window). */
  detail(id: string, now: number): PhoneFleetTicketDetail | undefined {
    this.prune(now);
    return this.entries.get(id)?.detail;
  }

  /** Whether `id` was looked up and not found within the last few seconds. */
  recentlyMissed(id: string, now: number): boolean {
    const until = this.misses.get(id);
    if (until === undefined) return false;
    if (until > now) return true;
    this.misses.delete(id);
    return false;
  }

  noteMiss(id: string, now: number): void {
    this.misses.delete(id);
    this.misses.set(id, now + MISS_TTL_MS);
    if (this.misses.size > MISS_LIMIT) this.misses.delete(this.misses.keys().next().value!);
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
   * The list's own rule: a finished ticket goes 24 hours after its last
   * change. Any ticket goes once no snapshot has listed it for 24 hours (the
   * desktop dropped it, e.g. abandoned). Over the bound, the least recently
   * seen go first.
   */
  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      const expired = ended(entry.state) && now - entry.detail.updatedAt > PHONE_FLEET_TICKET_RECENT_MS;
      if (expired || now - entry.seenAt > PHONE_FLEET_TICKET_RECENT_MS) this.entries.delete(id);
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
