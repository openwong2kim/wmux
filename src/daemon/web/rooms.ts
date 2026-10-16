// The phone's read-only view of the agent factory's rooms:
//
//   GET /api/rooms/:workspaceId/threads
//   GET /api/rooms/:workspaceId/cards?thread=&sinceSeq=&limit=
//
// The rooms live in Electron main; this daemon gates, asks main over the
// desktop bridge (shared/phoneRooms.ts names the two commands) and parses its
// reply with the same allowlist main projected with. It never caches a room.
//
// The gate is `--allow-transcript`, as for `/turns` and Fleet ticket text:
// cards are bot-authored text. Checked first, so a workspace is never
// confirmed or denied to a server that may not show it. No desktop, or one
// whose factory has not started, is 503: nothing here answers from memory.

import {
  PHONE_ROOM_CARDS_COMMAND,
  PHONE_ROOM_LIMITS,
  PHONE_ROOM_THREADS_COMMAND,
  isPhoneRoomWorkspaceId,
  parsePhoneRoomCardsReply,
  parsePhoneRoomThreadsReply,
} from '../../shared/phoneRooms';
import { parseThreadId, type ThreadId } from '../../shared/room';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';

export const ROOMS_ROUTE = /^\/api\/rooms\/([^/]+)\/(threads|cards)$/;

/** `POST /api/rooms/:workspaceId/messages`: the one room write, served by
 *  WebTerminalServer.handleRoomMessage on the Moa message path. */
export const ROOM_MESSAGES_ROUTE = /^\/api\/rooms\/([^/]+)\/messages$/;

/** The part of the desktop bridge the routes use (DesktopPhoneBridge). */
export interface RoomsDesktop {
  supports(command: string): boolean;
  request(command: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface RoomsResponse {
  status: number;
  body: unknown;
}

/** Whether both room commands answer on the attached desktop. */
export function roomsSupported(desktop: RoomsDesktop | null): boolean {
  return !!desktop && desktop.supports(PHONE_ROOM_THREADS_COMMAND) && desktop.supports(PHONE_ROOM_CARDS_COMMAND);
}

function decodeWorkspace(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isPhoneRoomWorkspaceId(id) ? id : null;
}

/** A query integer in [min, max], `undefined` when absent, null when malformed. */
function queryInt(value: string | null, min: number, max: number): number | undefined | null {
  if (value === null) return undefined;
  if (!/^[0-9]{1,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

async function ask(desktop: RoomsDesktop, command: string, payload: Record<string, unknown>): Promise<{ reply: unknown } | RoomsResponse> {
  try {
    return { reply: await desktop.request(command, payload) };
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
}

/** Main's refusals, shared by both routes; null when the reply is a page. */
function refusal(reply: unknown): RoomsResponse | null {
  const r = reply !== null && typeof reply === 'object' ? reply as Record<string, unknown> : {};
  if (r.unavailable === true) return { status: 503, body: { error: 'rooms-unavailable' } };
  if (r.notFound === true) return { status: 404, body: { error: 'room-not-found' } };
  if (r.invalid === true) return { status: 400, body: { error: 'invalid-room-request' } };
  return null;
}

/** `GET /api/rooms/:workspaceId/(threads|cards)`. Never throws. */
export async function roomsResponse(
  rawWorkspaceId: string,
  view: 'threads' | 'cards',
  query: URLSearchParams,
  opts: { allowTranscript: boolean; desktop: RoomsDesktop | null },
): Promise<RoomsResponse> {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'transcript-disabled' } };
  const workspaceId = decodeWorkspace(rawWorkspaceId);
  if (!workspaceId) return { status: 404, body: { error: 'room-not-found' } };
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!roomsSupported(desktop)) return { status: 503, body: { error: 'rooms-unavailable' } };

  if (view === 'threads') {
    const answered = await ask(desktop, PHONE_ROOM_THREADS_COMMAND, { workspaceId });
    if (!('reply' in answered)) return answered;
    const refused = refusal(answered.reply);
    if (refused) return refused;
    const page = parsePhoneRoomThreadsReply(answered.reply, workspaceId);
    return page ? { status: 200, body: page } : { status: 502, body: { error: 'desktop-bad-reply' } };
  }

  const rawThread = query.get('thread');
  let threadId: ThreadId | null = null;
  if (rawThread !== null) {
    threadId = parseThreadId(rawThread);
    if (!threadId) return { status: 400, body: { error: 'invalid-room-request', detail: 'thread' } };
  }
  const sinceSeq = queryInt(query.get('sinceSeq'), 0, Number.MAX_SAFE_INTEGER);
  if (sinceSeq === null) return { status: 400, body: { error: 'invalid-room-request', detail: 'sinceSeq' } };
  const limit = queryInt(query.get('limit'), 1, PHONE_ROOM_LIMITS.pageMax);
  if (limit === null) return { status: 400, body: { error: 'invalid-room-request', detail: 'limit' } };
  const answered = await ask(desktop, PHONE_ROOM_CARDS_COMMAND, {
    workspaceId,
    ...(threadId ? { threadId } : {}),
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    limit: limit ?? PHONE_ROOM_LIMITS.pageDefault,
  });
  if (!('reply' in answered)) return answered;
  const refused = refusal(answered.reply);
  if (refused) return refused;
  const page = parsePhoneRoomCardsReply(answered.reply, workspaceId, threadId);
  return page ? { status: 200, body: page } : { status: 502, body: { error: 'desktop-bad-reply' } };
}
