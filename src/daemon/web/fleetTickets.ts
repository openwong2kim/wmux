// The phone's Fleet tickets: the `/api/workspaces` keys and the
// `GET /api/fleet/tickets/<id>` detail. The desktop computes the tickets
// (phoneSidebarSnapshot.ts) and keeps their full text (main's
// PhoneFleetTicketStore); this daemon only gates and forwards.
//
// The gate is `--allow-transcript`, exactly as for history: a ticket's
// request, report and verification are agent-authored text. Applied when a
// reply is written, never when the snapshot is cached, because the same
// cached snapshot also feeds routes without the gate.

import { isSidebarId, type PhoneSidebarSnapshot } from '../../shared/phoneFleetSidebar';
import {
  FLEET_TICKET_DETAIL_COMMAND,
  parsePhoneFleetTicketDetail,
  withoutTicketTranscript,
  type PhoneFleetTicket,
} from '../../shared/phoneFleetTickets';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';

export const FLEET_TICKET_ROUTE_PREFIX = '/api/fleet/tickets/';

/**
 * The part of the desktop bridge the detail uses (DesktopPhoneBridge), narrow
 * so tests can stand in for it. The command is optional: a desktop announces
 * it at register, and `supports` says whether this one did.
 */
export interface FleetTicketDesktop {
  supports(command: string): boolean;
  request(command: string, payload: Record<string, unknown>): Promise<unknown>;
}

/**
 * The top-level `/api/workspaces` keys from the desktop's snapshot: the
 * ticket list (agent-authored lines only with `allowTranscript`) and the next
 * scheduled run. Each key is omitted when the snapshot has none.
 */
export function fleetTicketsFields(
  sidebar: PhoneSidebarSnapshot,
  allowTranscript: boolean,
): { fleetTickets?: PhoneFleetTicket[]; nextScheduleAt?: number } {
  return {
    ...(sidebar.fleetTickets !== undefined
      ? { fleetTickets: allowTranscript ? sidebar.fleetTickets : sidebar.fleetTickets.map(withoutTicketTranscript) }
      : {}),
    ...(sidebar.nextScheduleAt !== undefined ? { nextScheduleAt: sidebar.nextScheduleAt } : {}),
  };
}

export interface FleetTicketResponse {
  status: number;
  body: unknown;
}

/**
 * `GET /api/fleet/tickets/<id>`. 403 without `--allow-transcript` (checked
 * first, so an id is never confirmed or denied to a server that may not show
 * it), 503 while no desktop that serves details is attached, 404 for an id
 * the desktop does not know, 504 / 502 when the desktop does not answer or
 * answers badly. Never throws.
 */
export async function fleetTicketDetailResponse(
  rawId: string,
  opts: { allowTranscript: boolean; desktop: FleetTicketDesktop | null },
): Promise<FleetTicketResponse> {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'transcript-disabled' } };
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return { status: 404, body: { error: 'ticket-not-found' } };
  }
  // The list's own id rule.
  if (!isSidebarId(id)) return { status: 404, body: { error: 'ticket-not-found' } };
  const desktop = opts.desktop;
  if (!desktop || !desktop.supports(FLEET_TICKET_DETAIL_COMMAND)) return { status: 503, body: { error: 'desktop-unavailable' } };
  let reply: unknown;
  try {
    reply = await desktop.request(FLEET_TICKET_DETAIL_COMMAND, { id });
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const record = reply !== null && typeof reply === 'object' ? reply as Record<string, unknown> : undefined;
  if (record?.notFound === true) return { status: 404, body: { error: 'ticket-not-found' } };
  const ticket = parsePhoneFleetTicketDetail(record?.ticket);
  if (!ticket || ticket.id !== id) return { status: 502, body: { error: 'desktop-bad-reply' } };
  return { status: 200, body: { ticket } };
}
