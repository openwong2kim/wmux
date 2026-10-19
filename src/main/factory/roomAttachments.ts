// ─── The room's photo store (main) ─────────────────────────────────────────
//
// `<wmuxDir>/factory/room-attachments/<workspaceId>/<id>.jpg`, folder 0700,
// files 0600. Main is the only writer. Every photo is decoded and written
// once as a normalised JPEG (shared/roomAttachments.ts): the owner's card,
// the phone and the bot's turn all read that one copy.
//
// Sources: a phone upload (`importUpload`, by its file name in the daemon's
// uploads folder, checked against the size and SHA-256 the daemon read) or
// a file the owner picked on the desktop (`importFile`). A source is read
// through one descriptor opened without following a link, after lstat said
// it is a regular file; its type is decided by its bytes.
//
// All IO is synchronous: a caller does find → import → post with nothing
// awaited in between, so one message id never copies its photos twice.
//
// Retention is by age, not by the cards: a stored file older than the
// room's retention plus a day is swept (on start and at most hourly on
// import). The cards are not consulted, so an older build that rewrites a
// room without the `attachments` field never costs a photo its file early.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { ROOM_LIMITS } from '../../shared/room';
import {
  ROOM_ATTACHMENT_ID_RE,
  ROOM_ATTACHMENT_LIMITS,
  ROOM_ATTACHMENT_MEDIA_TYPE,
  UPLOAD_NAME_RE,
  sniffRoomImage,
  type RoomAttachment,
} from '../../shared/roomAttachments';
import type { MoaWakeAttachment, MoaWakeAttachmentRefusal } from '../../shared/moaWake';

export const ROOM_ATTACHMENTS_DIRNAME = 'room-attachments';

const DAY_MS = 24 * 3600_000;
/** A stored photo older than this is swept: the room keeps no card longer. */
export const ROOM_ATTACHMENT_RETAIN_MS = (ROOM_LIMITS.RETAIN_DAYS + 1) * DAY_MS;
const SWEEP_EVERY_MS = 3600_000;
const STORED_RE = /^([0-9a-f]{32})\.jpg$/;
const TEMP_RE = /^[0-9a-f]{32}\.jpg\.tmp$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Decode an image and write the normalised copy; null when it cannot be
 *  decoded. Injected in tests (Electron's nativeImage otherwise). */
export type RoomImageNormalizer = (source: Buffer) => { data: Buffer; width: number; height: number } | null;

export type RoomAttachmentImport =
  | { ok: true; attachment: RoomAttachment }
  | { ok: false; reason: MoaWakeAttachmentRefusal | 'full' };

export interface RoomAttachmentStoreOptions {
  /** `<wmuxDir>/factory/room-attachments` */
  root: string;
  /** The daemon's phone uploads folder, `<wmuxDir>/uploads/phone`. */
  uploadsDir: string;
  normalize?: RoomImageNormalizer;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

/** nativeImage: long edge ≤ MODEL_EDGE, JPEG at JPEG_QUALITY. */
export const nativeImageNormalizer: RoomImageNormalizer = (source) => {
  const image = nativeImage.createFromBuffer(source);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width < 1 || height < 1) return null;
  const scale = Math.min(1, ROOM_ATTACHMENT_LIMITS.MODEL_EDGE / Math.max(width, height));
  const out = scale < 1
    ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
    : image;
  const size = out.getSize();
  return { data: out.toJPEG(ROOM_ATTACHMENT_LIMITS.JPEG_QUALITY), width: size.width, height: size.height };
};

/** Read a regular file through one descriptor that never follows a link.
 *  `missing` for anything that is not one (or vanished), `size` over `max`. */
function readRegularFile(file: string, max: number): { ok: true; data: Buffer } | { ok: false; reason: 'missing' | 'size' } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!st.isFile() || st.isSymbolicLink()) return { ok: false, reason: 'missing' };
  if (st.size > max) return { ok: false, reason: 'size' };
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { ok: false, reason: 'missing' };
    if (fst.size > max) return { ok: false, reason: 'size' };
    return { ok: true, data: fs.readFileSync(fd) };
  } catch {
    return { ok: false, reason: 'missing' };
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/** A directory that is not a link. */
function isRealDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A directory that is not a link, or nothing there yet. */
function realDirOrAbsent(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

export class RoomAttachmentStore {
  private readonly normalize: RoomImageNormalizer;
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;
  private lastSweep = 0;

  constructor(private readonly opts: RoomAttachmentStoreOptions) {
    this.normalize = opts.normalize ?? nativeImageNormalizer;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m, e) => console.warn(`[factory] room photos: ${m}`, e ?? ''));
  }

  /** A workspace's folder, or null for an id that is not one, or when the
   *  store or the folder is not a real directory (a link is never followed:
   *  a read, a write or the sweep would otherwise reach outside the store). */
  private dir(workspaceId: string): string | null {
    if (!WORKSPACE_ID_RE.test(workspaceId) || workspaceId === '.' || workspaceId === '..') return null;
    const dir = path.join(this.opts.root, workspaceId);
    return realDirOrAbsent(this.opts.root) && realDirOrAbsent(dir) ? dir : null;
  }

  /** Where a stored photo is, or null for an id or workspace that is not one. */
  file(workspaceId: string, id: string): string | null {
    const dir = this.dir(workspaceId);
    return dir && ROOM_ATTACHMENT_ID_RE.test(id) ? path.join(dir, `${id}.jpg`) : null;
  }

  /** The stored copy's bytes, or null. */
  read(workspaceId: string, id: string): Buffer | null {
    const file = this.file(workspaceId, id);
    if (!file) return null;
    const r = readRegularFile(file, ROOM_ATTACHMENT_LIMITS.STORED_MAX_BYTES);
    return r.ok ? r.data : null;
  }

  /** The stored copy's size in bytes, or null when there is none. */
  size(workspaceId: string, id: string): number | null {
    const file = this.file(workspaceId, id);
    if (!file) return null;
    try {
      const st = fs.lstatSync(file);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  }

  /** A phone upload, by its name in the uploads folder. */
  importUpload(workspaceId: string, upload: MoaWakeAttachment): RoomAttachmentImport {
    // A name alone (the daemon found no file) is never copied unchecked.
    if (typeof upload.uploadId !== 'string' || !UPLOAD_NAME_RE.test(upload.uploadId) || upload.bytes === undefined || upload.sha256 === undefined) {
      return { ok: false, reason: 'missing' };
    }
    const read = readRegularFile(path.join(this.opts.uploadsDir, upload.uploadId), ROOM_ATTACHMENT_LIMITS.SOURCE_MAX_BYTES);
    if (!read.ok) return read;
    // The daemon checked these bytes; a file changed since is not the one sent.
    if (read.data.length !== upload.bytes || crypto.createHash('sha256').update(read.data).digest('hex') !== upload.sha256) {
      return { ok: false, reason: 'changed' };
    }
    return this.store(workspaceId, read.data, upload.uploadId);
  }

  /** A file the owner picked on the desktop (an absolute, already resolved path). */
  importFile(workspaceId: string, file: string): RoomAttachmentImport {
    if (!path.isAbsolute(file)) return { ok: false, reason: 'missing' };
    const read = readRegularFile(file, ROOM_ATTACHMENT_LIMITS.SOURCE_MAX_BYTES);
    if (!read.ok) return read;
    return this.store(workspaceId, read.data);
  }

  private store(workspaceId: string, source: Buffer, upload?: string): RoomAttachmentImport {
    const dir = this.dir(workspaceId);
    if (!dir) return { ok: false, reason: 'missing' };
    if (!sniffRoomImage(source.subarray(0, 16))) return { ok: false, reason: 'type' };
    let normal: ReturnType<RoomImageNormalizer>;
    try {
      normal = this.normalize(source);
    } catch (err) {
      this.log('a photo could not be decoded', err);
      normal = null;
    }
    if (!normal || normal.data.length === 0) return { ok: false, reason: 'type' };
    if (normal.data.length > ROOM_ATTACHMENT_LIMITS.STORED_MAX_BYTES) return { ok: false, reason: 'size' };
    this.maybeSweep();
    const held = this.measure(dir);
    if (held.files + 1 > ROOM_ATTACHMENT_LIMITS.ROOM_MAX_FILES || held.bytes + normal.data.length > ROOM_ATTACHMENT_LIMITS.ROOM_MAX_BYTES) {
      return { ok: false, reason: 'full' };
    }
    const id = crypto.randomBytes(16).toString('hex');
    const final = path.join(dir, `${id}.jpg`);
    const temp = `${final}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Made just now or before: still a real folder of the store.
      if (!isRealDir(this.opts.root) || !isRealDir(dir)) throw new Error('the photo folder is not a directory');
      fs.writeFileSync(temp, normal.data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, final);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch { /* not written */ }
      this.log('a photo was not stored', err);
      return { ok: false, reason: 'missing' };
    }
    return {
      ok: true,
      attachment: {
        id, mediaType: ROOM_ATTACHMENT_MEDIA_TYPE, bytes: normal.data.length,
        width: normal.width, height: normal.height,
        ...(upload ? { upload } : {}),
      },
    };
  }

  /** Remove photos no card took (a post that wrote no card). */
  remove(workspaceId: string, ids: readonly string[]): void {
    for (const id of ids) {
      const file = this.file(workspaceId, id);
      if (!file) continue;
      try { fs.unlinkSync(file); } catch { /* gone */ }
    }
  }

  private measure(dir: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { files, bytes };
    }
    for (const name of names) {
      if (!STORED_RE.test(name)) continue;
      try {
        bytes += fs.statSync(path.join(dir, name)).size;
        files += 1;
      } catch { /* vanished */ }
    }
    return { files, bytes };
  }

  private maybeSweep(): void {
    if (this.now() - this.lastSweep < SWEEP_EVERY_MS) return;
    this.sweep();
  }

  /** Delete stored photos older than the room keeps a card, and stray
   *  temporary files. Only names this store writes are touched. */
  sweep(): void {
    const now = this.now();
    this.lastSweep = now;
    let workspaces: string[] = [];
    if (!isRealDir(this.opts.root)) return;
    try {
      workspaces = fs.readdirSync(this.opts.root);
    } catch {
      return;
    }
    for (const ws of workspaces) {
      const dir = this.dir(ws);
      if (!dir || !isRealDir(dir)) continue;
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const stored = STORED_RE.test(name);
        if (!stored && !TEMP_RE.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const st = fs.lstatSync(file);
          const age = now - st.mtimeMs;
          if (stored ? age > ROOM_ATTACHMENT_RETAIN_MS : age > SWEEP_EVERY_MS) fs.unlinkSync(file);
        } catch { /* vanished */ }
      }
    }
  }
}

let current: RoomAttachmentStore | null = null;

/** The store the factory uses (set at factory start). */
export function setRoomAttachmentStore(store: RoomAttachmentStore | null): void {
  current = store;
}

export function getRoomAttachmentStore(): RoomAttachmentStore | null {
  return current;
}

/** Bot turns: the photos of an owner card, base64, for the turn's prompt.
 *  `missing` counts the ones whose file is gone. */
export function cardImages(store: RoomAttachmentStore | null, workspaceId: string, attachments: readonly RoomAttachment[] | undefined): { images: Array<{ mediaType: string; data: string }>; missing: number } {
  const images: Array<{ mediaType: string; data: string }> = [];
  let missing = 0;
  for (const a of attachments ?? []) {
    const data = store?.read(workspaceId, a.id) ?? null;
    if (data) images.push({ mediaType: a.mediaType, data: data.toString('base64') });
    else missing += 1;
  }
  return { images, missing };
}
