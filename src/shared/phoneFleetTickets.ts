// Fleet tickets for the phone: the list rides the sidebar snapshot
// (`PhoneSidebarSnapshot.fleetTickets`, parsed in phoneFleetSidebar.ts, the
// single allowlist for that reply); this module holds the rest of the
// contract — the detail one ticket opens to, the desktop command that answers
// it, and the transcript gate both routes apply.
//
// Path of the detail: the renderer projects every ticket's full request,
// report and evidence beside its snapshot (`PHONE_FLEET_TICKET_DETAILS_KEY`,
// a key the snapshot parser does not list, so it never reaches the daemon
// that way); main keeps them in a bounded memory store (PhoneFleetTicketStore)
// because the daemon drops an ended A2A task after 30 minutes; the daemon
// asks main for one with `FLEET_TICKET_DETAIL_COMMAND`.

import { clampSidebarString, hasUnsafeSidebarText, isSidebarId } from './phoneFleetSidebar';
import type { PhoneFleetTicket } from './phoneFleetSidebar';

export type { PhoneFleetTicket, PhoneFleetTicketOrigin, PhoneFleetTicketState } from './phoneFleetSidebar';
export { PHONE_FLEET_TICKET_ORIGINS, PHONE_FLEET_TICKET_RECENT_MS, PHONE_FLEET_TICKET_STATES } from './phoneFleetSidebar';

/**
 * The desktop command for one ticket's detail. Under `workspaces.` so main's
 * existing dispatch hands it to PhoneWorkspaces.
 */
export const FLEET_TICKET_DETAIL_COMMAND = 'workspaces.fleetTicket';

/** The renderer's side key carrying ticket details to main; never forwarded. */
export const PHONE_FLEET_TICKET_DETAILS_KEY = 'fleetTicketDetails';

export const PHONE_FLEET_TICKET_DETAIL_LIMITS = {
  /** Full request and report text, in UTF-16 code units. */
  text: 4000,
  /** Evidence items per ticket. */
  items: 16,
  /** Each item's summary, command and location. */
  itemText: 200,
  /** Tickets main keeps details for. */
  store: 50,
} as const;

export interface PhoneFleetTicketVerificationItem {
  kind: 'command' | 'inspection' | 'artifact';
  /** The worker's own word: passed / failed for a command, verified / unverified otherwise. */
  status: 'passed' | 'failed' | 'verified' | 'unverified';
  /** What the item checked, single-line and bounded. */
  summary: string;
  /** What was run (command items). */
  command?: string;
  /** What was looked at (inspection / artifact items). */
  location?: string;
}

/** `GET /api/fleet/tickets/<id>`: all agent-authored text, behind `--allow-transcript`. */
export interface PhoneFleetTicketDetail {
  id: string;
  /** The request as it was sent, multi-line and bounded. */
  request?: string;
  /** The final report, multi-line and bounded; only once the job ended. */
  result?: string;
  /** Verified items over all items, e.g. "3/4". */
  verification?: string;
  verificationItems?: PhoneFleetTicketVerificationItem[];
  /** Epoch ms of the ticket version this detail belongs to. */
  updatedAt: number;
}

const ITEM_STATUSES: Record<PhoneFleetTicketVerificationItem['kind'], readonly string[]> = {
  command: ['passed', 'failed'],
  inspection: ['verified', 'unverified'],
  artifact: ['verified', 'unverified'],
};
const VERIFICATION_RE = /^\d{1,5}\/\d{1,5}$/;
// Everything `hasUnsafeSidebarText` refuses except the line feed, which a
// request or report keeps.
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE_G = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Multi-line text made safe for a phone view: CRLF and CR become LF, every
 * other control and bidi character goes, cut to `max` without splitting a
 * surrogate pair. Undefined when nothing readable is left.
 */
export function clampTicketText(value: unknown, max = PHONE_FLEET_TICKET_DETAIL_LIMITS.text): string | undefined {
  if (typeof value !== 'string') return undefined;
  let out = value.replace(/\r\n?/g, '\n').replace(UNSAFE_MULTILINE_G, '').trim();
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out.length > 0 ? out : undefined;
}

/** The first non-blank line, one safe line cut to `max`. */
export function firstTicketLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // A bounded head only: a request can be many kilobytes.
  const line = value.slice(0, 4 * max).split(/\r\n|[\n\r\u0085\u2028\u2029]/).find((l) => l.trim().length > 0);
  return clampSidebarString(line, max);
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !UNSAFE_MULTILINE.test(value)
    ? value
    : undefined;
}

function boundedLine(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !hasUnsafeSidebarText(value)
    ? value
    : undefined;
}

function parseItem(value: unknown): PhoneFleetTicketVerificationItem | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== 'command' && kind !== 'inspection' && kind !== 'artifact') return undefined;
  if (typeof value.status !== 'string' || !ITEM_STATUSES[kind].includes(value.status)) return undefined;
  const max = PHONE_FLEET_TICKET_DETAIL_LIMITS.itemText;
  const summary = boundedLine(value.summary, max);
  if (summary === undefined) return undefined;
  const item: PhoneFleetTicketVerificationItem = { kind, status: value.status as PhoneFleetTicketVerificationItem['status'], summary };
  const command = kind === 'command' ? boundedLine(value.command, max) : undefined;
  if (command !== undefined) item.command = command;
  const location = kind !== 'command' ? boundedLine(value.location, max) : undefined;
  if (location !== undefined) item.location = location;
  return item;
}

/**
 * The allowlist for one detail, at every hop (main on the renderer's side
 * key, the daemon on main's reply). Null without a valid id and time; a bad
 * optional field is dropped on its own.
 */
export function parsePhoneFleetTicketDetail(value: unknown): PhoneFleetTicketDetail | null {
  if (!isRecord(value) || !isSidebarId(value.id)) return null;
  const updatedAt = value.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) return null;
  const detail: PhoneFleetTicketDetail = { id: value.id, updatedAt };
  const max = PHONE_FLEET_TICKET_DETAIL_LIMITS.text;
  const request = boundedText(value.request, max);
  if (request !== undefined) detail.request = request;
  const result = boundedText(value.result, max);
  if (result !== undefined) detail.result = result;
  if (typeof value.verification === 'string' && VERIFICATION_RE.test(value.verification)) detail.verification = value.verification;
  if (Array.isArray(value.verificationItems)) {
    const items = value.verificationItems
      .slice(0, PHONE_FLEET_TICKET_DETAIL_LIMITS.items)
      .map(parseItem)
      .filter((item): item is PhoneFleetTicketVerificationItem => item !== undefined);
    if (items.length > 0) detail.verificationItems = items;
  }
  return detail;
}

/** Many details (the renderer's side key), deduplicated by id and bounded. */
export function parsePhoneFleetTicketDetails(value: unknown): PhoneFleetTicketDetail[] {
  if (!Array.isArray(value)) return [];
  const out: PhoneFleetTicketDetail[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= PHONE_FLEET_TICKET_DETAIL_LIMITS.store) break;
    const detail = parsePhoneFleetTicketDetail(raw);
    if (!detail || seen.has(detail.id)) continue;
    seen.add(detail.id);
    out.push(detail);
  }
  return out;
}

/**
 * The list as a server without `--allow-transcript` serves it: every
 * agent-authored field (request line, report line, verification) left out,
 * everything else as it is.
 */
export function withoutTicketTranscript(ticket: PhoneFleetTicket): PhoneFleetTicket {
  const { requestLine: _requestLine, resultSummary: _resultSummary, verification: _verification, ...rest } = ticket;
  return rest;
}
