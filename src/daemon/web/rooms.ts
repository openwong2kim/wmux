// The phone's read-only view of the agent factory's rooms:
//
//   GET /api/rooms/:workspaceId/threads
//   GET /api/rooms/:workspaceId/cards?thread=&sinceSeq=&limit=
//   GET /api/rooms/:workspaceId/attachments/:attachmentId (an owner's photo)
//   GET /api/rooms/:workspaceId/files/:fileId (a file a bot handed the owner)
//
// The rooms live in Electron main; this daemon gates, asks main over the
// desktop bridge (shared/phoneRooms.ts names the two commands) and parses its
// reply with the same allowlist main projected with. It never caches a room.
//
// The gate is `--allow-transcript`, as for `/turns` and Fleet ticket text:
// cards are bot-authored text. Checked first, so a workspace is never
// confirmed or denied to a server that may not show it. No desktop, or one
// whose factory has not started, is 503: nothing here answers from memory.

import { once } from 'node:events';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import {
  PHONE_ROOM_ATTACHMENT_COMMAND,
  PHONE_ROOM_CARDS_COMMAND,
  PHONE_ROOM_FILE_COMMAND,
  PHONE_ROOM_FILE_DOWNLOAD_TYPE,
  PHONE_ROOM_LIMITS,
  PHONE_ROOM_THREADS_COMMAND,
  isPhoneRoomWorkspaceId,
  parsePhoneRoomCardsReply,
  parsePhoneRoomFile,
  parsePhoneRoomThreadsReply,
} from '../../shared/phoneRooms';
import { parseThreadId, type ThreadId } from '../../shared/room';
import { sameFileId } from '../../shared/sameFileId';
import { ROOM_ATTACHMENT_ID_RE, ROOM_ATTACHMENT_LIMITS, ROOM_ATTACHMENT_MEDIA_TYPE, sniffRoomImage } from '../../shared/roomAttachments';
import { ROOM_FILE_ID_RE, ROOM_FILE_LIMITS } from '../../shared/roomFiles';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';

export const ROOMS_ROUTE = /^\/api\/rooms\/([^/]+)\/(threads|cards)$/;

/** `POST /api/rooms/:workspaceId/messages`: the one room write, served by
 *  WebTerminalServer.handleRoomMessage on the Moa message path. */
export const ROOM_MESSAGES_ROUTE = /^\/api\/rooms\/([^/]+)\/messages$/;

/** `GET /api/rooms/:workspaceId/attachments/:attachmentId`: one photo of an
 *  owner card, the bytes of the room's stored copy. */
export const ROOM_ATTACHMENT_ROUTE = /^\/api\/rooms\/([^/]+)\/attachments\/([^/]+)$/;

/** `GET /api/rooms/:workspaceId/files/:fileId`: one file on a bot card, the
 *  bytes of the room's stored copy. */
export const ROOM_FILE_ROUTE = /^\/api\/rooms\/([^/]+)\/files\/([^/]+)$/;

/** Downloads one caller (a device, or the operator) may have open at once;
 *  one more is 429. */
export const ROOM_FILE_STREAMS_PER_CALLER = 4;

/** A download whose socket has sent nothing for this long (the phone
 *  stopped reading) is cut. */
export const ROOM_FILE_STALL_MS = 30_000;

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

/** A bot file ready to stream: the open stored copy, owned by the caller of
 *  sendRoomFile, which closes it. */
export interface RoomFileOpen {
  status: 200;
  handle: fs.promises.FileHandle;
  size: number;
  name: string;
  contentType: string;
}

export type RoomFileResponse = RoomsResponse | RoomFileOpen;

const FILE_NOT_FOUND: RoomsResponse = { status: 404, body: { error: 'file-not-found' } };

/** No link followed, and a FIFO swapped in never blocks the open. */
const FILE_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * `GET /api/rooms/:workspaceId/files/:fileId`. Gated like the photo route:
 * the transcript grant, then main says whether a kept bot card of that room
 * carries the id (with its name, size and media type). The stored copy is
 * opened from `roomFilesDir` without following a link and must be that file
 * and that size. Every way it is not there is the same 404. The type is
 * main's, never sniffed (a stored copy has no extension). Files run to
 * 10 MiB, so the bytes are streamed by sendRoomFile, not read whole.
 */
export async function roomFileResponse(
  rawWorkspaceId: string,
  rawFileId: string,
  opts: { allowTranscript: boolean; desktop: RoomsDesktop | null; roomFilesDir: string | undefined },
): Promise<RoomFileResponse> {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'transcript-disabled' } };
  const workspaceId = decodeWorkspace(rawWorkspaceId);
  if (!workspaceId || !ROOM_FILE_ID_RE.test(rawFileId)) return FILE_NOT_FOUND;
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!desktop.supports(PHONE_ROOM_FILE_COMMAND) || !opts.roomFilesDir) return { status: 503, body: { error: 'rooms-unavailable' } };
  const answered = await ask(desktop, PHONE_ROOM_FILE_COMMAND, { workspaceId, fileId: rawFileId });
  if (!('reply' in answered)) return answered;
  const reply = answered.reply !== null && typeof answered.reply === 'object' ? answered.reply as Record<string, unknown> : {};
  if (reply.unavailable === true) return { status: 503, body: { error: 'rooms-unavailable' } };
  const meta = parsePhoneRoomFile({ ...(reply.file !== null && typeof reply.file === 'object' ? reply.file : {}), id: rawFileId });
  if (!meta) return FILE_NOT_FOUND;
  const folder = path.join(opts.roomFilesDir, workspaceId);
  const file = path.join(folder, rawFileId);
  let handle: fs.promises.FileHandle | null = null;
  try {
    // Neither the store nor the room's folder may be a link.
    let room: fs.BigIntStats | null = null;
    for (const dir of [opts.roomFilesDir, folder]) {
      room = await fs.promises.lstat(dir, { bigint: true });
      if (!room.isDirectory() || room.isSymbolicLink()) return FILE_NOT_FOUND;
    }
    const st = await fs.promises.lstat(file, { bigint: true });
    if (!st.isFile() || Number(st.size) !== meta.bytes || st.size > ROOM_FILE_LIMITS.MAX_BYTES) return FILE_NOT_FOUND;
    handle = await fs.promises.open(file, FILE_OPEN_FLAGS);
    const fst = await handle.stat({ bigint: true });
    // O_NOFOLLOW guards only the last name and Node has no openat, so the
    // room's folder is checked again: still the directory it was, not a
    // link swapped in while the file was opened.
    const after = await fs.promises.lstat(folder, { bigint: true });
    const sameRoom = !!room && after.isDirectory() && sameFileId(after, room);
    if (!sameRoom || !fst.isFile() || Number(fst.size) !== meta.bytes || !sameFileId(fst, st)) {
      await handle.close().catch(() => undefined);
      return FILE_NOT_FOUND;
    }
    return { status: 200, handle, size: Number(fst.size), name: meta.name, contentType: meta.mediaType };
  } catch {
    await handle?.close().catch(() => undefined);
    return FILE_NOT_FOUND;
  }
}

/** RFC 5987 `filename*` value: every byte outside its attr-char set escaped. */
function contentDispositionName(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Streams an opened bot file and closes it. Content-Length is the size main
 * named; a file that shrank mid-stream sends fewer bytes than that header
 * promised, so the socket is cut rather than ended cleanly. A file the phone
 * may not show in place (parsePhoneRoomFile named it
 * PHONE_ROOM_FILE_DOWNLOAD_TYPE) goes out as an attachment.
 */
export async function sendRoomFile(
  res: ServerResponse,
  file: RoomFileOpen,
  headers: Record<string, string>,
  opts: { stallMs?: number } = {},
): Promise<void> {
  let opened: fs.ReadStream | null = null;
  try {
    const disposition = file.contentType === PHONE_ROOM_FILE_DOWNLOAD_TYPE ? 'attachment' : 'inline';
    res.writeHead(200, {
      ...headers,
      'Content-Type': file.contentType,
      'Content-Length': String(file.size),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${contentDispositionName(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      // Inert even if opened as a document.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.setTimeout(opts.stallMs ?? ROOM_FILE_STALL_MS, () => { res.destroy(); });
    // The handle stays ours to close (and to count against below).
    const stream = file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false });
    opened = stream;
    // Heard for the stream's whole life: a read still in flight when the
    // phone leaves can fail after pipe and finished have let go.
    stream.on('error', () => undefined);
    // A phone that leaves mid-download: pipe never destroys its source.
    const abort = (): void => { stream.destroy(); };
    res.once('close', abort);
    // It may already have left during the awaits before the first byte.
    if (res.destroyed) {
      stream.destroy();
      return;
    }
    try {
      stream.pipe(res, { end: false });
      await finished(stream);
    } finally {
      res.off('close', abort);
    }
    if (res.destroyed) return;
    if (stream.bytesRead !== file.size) res.destroy();
    else res.end();
  } catch {
    if (!res.destroyed) res.destroy();
  } finally {
    // A destroyed stream finishes its read and closes the handle itself
    // before 'close'; the handle is closed only after that.
    if (opened && !opened.closed) {
      const closed = once(opened, 'close');
      opened.destroy();
      await closed;
    }
    await file.handle.close().catch(() => undefined);
  }
}
