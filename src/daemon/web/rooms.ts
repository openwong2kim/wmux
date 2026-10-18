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

import fs from 'node:fs';
import path from 'node:path';
import {
  PHONE_ROOM_ATTACHMENT_COMMAND,
  PHONE_ROOM_CARDS_COMMAND,
  PHONE_ROOM_LIMITS,
  PHONE_ROOM_THREADS_COMMAND,
  isPhoneRoomWorkspaceId,
  parsePhoneRoomCardsReply,
  parsePhoneRoomThreadsReply,
} from '../../shared/phoneRooms';
import { parseThreadId, type ThreadId } from '../../shared/room';
import { ROOM_ATTACHMENT_ID_RE, ROOM_ATTACHMENT_LIMITS, ROOM_ATTACHMENT_MEDIA_TYPE, sniffRoomImage } from '../../shared/roomAttachments';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';

export const ROOMS_ROUTE = /^\/api\/rooms\/([^/]+)\/(threads|cards)$/;

/** `POST /api/rooms/:workspaceId/messages`: the one room write, served by
 *  WebTerminalServer.handleRoomMessage on the Moa message path. */
export const ROOM_MESSAGES_ROUTE = /^\/api\/rooms\/([^/]+)\/messages$/;

/** `GET /api/rooms/:workspaceId/attachments/:attachmentId`: one photo of an
 *  owner card, the bytes of the room's stored copy. */
export const ROOM_ATTACHMENT_ROUTE = /^\/api\/rooms\/([^/]+)\/attachments\/([^/]+)$/;

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

/** A photo answer: the bytes, or a JSON refusal. */
export type RoomAttachmentResponse = RoomsResponse | { status: 200; bytes: Buffer; contentType: string };

const ATTACHMENT_NOT_FOUND: RoomsResponse = { status: 404, body: { error: 'attachment-not-found' } };

/**
 * `GET /api/rooms/:workspaceId/attachments/:attachmentId[?variant=thumb]`.
 * Transcript-gated like the cards. Main says whether a kept owner card of
 * that room carries the id (and its size); then the stored copy is read from
 * `roomAttachmentsDir` through one descriptor that follows no link, and must
 * be that size and a JPEG. Every way it is not there is the same 404. The
 * stored copy is already the small one, so `variant=thumb` answers it too.
 */
export async function roomAttachmentResponse(
  rawWorkspaceId: string,
  rawAttachmentId: string,
  query: URLSearchParams,
  opts: { allowTranscript: boolean; desktop: RoomsDesktop | null; roomAttachmentsDir: string | undefined },
): Promise<RoomAttachmentResponse> {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'transcript-disabled' } };
  const workspaceId = decodeWorkspace(rawWorkspaceId);
  if (!workspaceId || !ROOM_ATTACHMENT_ID_RE.test(rawAttachmentId)) return ATTACHMENT_NOT_FOUND;
  const variant = query.get('variant');
  if (variant !== null && variant !== 'thumb') return { status: 400, body: { error: 'invalid-room-request', detail: 'variant' } };
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!desktop.supports(PHONE_ROOM_ATTACHMENT_COMMAND) || !opts.roomAttachmentsDir) return { status: 503, body: { error: 'rooms-unavailable' } };
  const answered = await ask(desktop, PHONE_ROOM_ATTACHMENT_COMMAND, { workspaceId, attachmentId: rawAttachmentId });
  if (!('reply' in answered)) return answered;
  const reply = answered.reply !== null && typeof answered.reply === 'object' ? answered.reply as Record<string, unknown> : {};
  if (reply.unavailable === true) return { status: 503, body: { error: 'rooms-unavailable' } };
  const meta = reply.attachment !== null && typeof reply.attachment === 'object' ? reply.attachment as Record<string, unknown> : null;
  if (!meta || meta.mediaType !== ROOM_ATTACHMENT_MEDIA_TYPE || typeof meta.bytes !== 'number') return ATTACHMENT_NOT_FOUND;
  const folder = path.join(opts.roomAttachmentsDir, workspaceId);
  const file = path.join(folder, `${rawAttachmentId}.jpg`);
  let bytes: Buffer;
  try {
    // Neither the store nor the room's folder may be a link: the file must
    // be inside the store, not wherever a link points.
    for (const dir of [opts.roomAttachmentsDir, folder]) {
      const d = await fs.promises.lstat(dir);
      if (!d.isDirectory() || d.isSymbolicLink()) return ATTACHMENT_NOT_FOUND;
    }
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size !== meta.bytes || st.size > ROOM_ATTACHMENT_LIMITS.STORED_MAX_BYTES) return ATTACHMENT_NOT_FOUND;
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const fst = await handle.stat();
      if (!fst.isFile() || fst.size !== meta.bytes) return ATTACHMENT_NOT_FOUND;
      bytes = await handle.readFile();
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return ATTACHMENT_NOT_FOUND;
  }
  if (sniffRoomImage(bytes.subarray(0, 16)) !== ROOM_ATTACHMENT_MEDIA_TYPE) return ATTACHMENT_NOT_FOUND;
  return { status: 200, bytes, contentType: ROOM_ATTACHMENT_MEDIA_TYPE };
}
