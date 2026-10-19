// ─── Photos on Bots room messages ──────────────────────────────────────────
//
// The owner may attach photos to a message in a Bots conversation, from the
// desktop composer or from the phone (`POST /api/rooms/:ws/messages` with
// `attachments: [{uploadId}]`). Main copies each one into the room's own
// store, `<wmuxDir>/factory/room-attachments/<workspaceId>/<id>.jpg`, as ONE
// normalised JPEG (long edge at most MODEL_EDGE px): that copy is what the
// owner's card shows, what the phone fetches and what the bot sees in its
// turn. The original is never kept, so a resumed bot conversation does not
// grow by full-size pictures. A stored photo lives as long as the card can
// (the room's retention plus a day), then main sweeps it by age.
//
// Ids are 128 random bits as hex; no path ever reaches a wire.

export const ROOM_ATTACHMENT_LIMITS = {
  /** Photos one message may carry. */
  PER_MESSAGE: 4,
  /** The largest source file taken (the phone upload cap). */
  SOURCE_MAX_BYTES: 10 * 1024 * 1024,
  /** The stored copy's long edge, px: the size a model reads best at. */
  MODEL_EDGE: 1568,
  /** JPEG quality of the stored copy. */
  JPEG_QUALITY: 80,
  /** A stored copy larger than this is refused (it would not fit a prompt). */
  STORED_MAX_BYTES: 3 * 1024 * 1024,
  /** What one room's store may hold. */
  ROOM_MAX_FILES: 2000,
  ROOM_MAX_BYTES: 1024 * 1024 * 1024,
} as const;

export const ROOM_ATTACHMENT_ID_RE = /^[0-9a-f]{32}$/;

/** The one type a stored copy has. */
export const ROOM_ATTACHMENT_MEDIA_TYPE = 'image/jpeg';

/** One photo on an owner card. `upload` (main-side only, never on the
 *  phone wire) is the phone upload it was copied from, so a resent message
 *  id can be checked against the photos it first carried. */
export interface RoomAttachment {
  id: string;
  mediaType: typeof ROOM_ATTACHMENT_MEDIA_TYPE;
  bytes: number;
  width?: number;
  height?: number;
  upload?: string;
}

/**
 * Exactly the names the daemon's `/api/upload` and `/api/upload-file`
 * generate, every segment anchored: `photo-` + an ISO 8601 instant with `:`
 * and `.` rewritten to `-` + `-` + eight lowercase hex + `.jpg` or `.png`;
 * general files use the same shape with `file-` and a bounded alphanumeric
 * extension.
 *
 * It is the uploads sweep's DELETION predicate, so it is over-strict on
 * purpose: `~/.wmux/uploads` is also where an operator stages files for
 * `browser_file_upload`, and a looser pattern would unlink their
 * `photo-vacation.jpg`. It is also the only name a room message may name.
 */
export const UPLOAD_NAME_RE = /^(?:photo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.(?:jpg|png)|file-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.[a-z0-9]{1,12})$/;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG or JPEG by the leading bytes, else null. The two formats a room takes. */
export function sniffRoomImage(head: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => head[i] === b)) return 'image/png';
  return null;
}

function dimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : undefined;
}

/** A stored attachment list, or undefined when there is none worth keeping.
 *  Unknown fields, bad ids and duplicates are dropped; at most PER_MESSAGE. */
export function parseRoomAttachments(value: unknown, opts: { keepUpload?: boolean } = {}): RoomAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RoomAttachment[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= ROOM_ATTACHMENT_LIMITS.PER_MESSAGE) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string' || !ROOM_ATTACHMENT_ID_RE.test(a.id) || seen.has(a.id)) continue;
    if (a.mediaType !== ROOM_ATTACHMENT_MEDIA_TYPE) continue;
    if (typeof a.bytes !== 'number' || !Number.isSafeInteger(a.bytes) || a.bytes <= 0) continue;
    seen.add(a.id);
    const width = dimension(a.width);
    const height = dimension(a.height);
    out.push({
      id: a.id, mediaType: ROOM_ATTACHMENT_MEDIA_TYPE, bytes: a.bytes,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(opts.keepUpload !== false && typeof a.upload === 'string' && UPLOAD_NAME_RE.test(a.upload) ? { upload: a.upload } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** A photo-only card's title: wmux's placeholder, drawn by no client. */
export function photoPlaceholderTitle(count: number): string {
  return count === 1 ? 'Photo' : `${count} photos`;
}
