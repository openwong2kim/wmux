// ─── The room's file store: files a bot attached to its cards (main) ───────
//
// `<wmuxDir>/factory/room-files/<workspaceId>/<id>`, folder 0700, files
// 0600. Main is the only writer. A bot names files it made (room_post
// `files`, shared/roomFiles.ts); each is copied here once, so the owner can
// open it after the task folder it came from is gone.
//
// A source is taken only when (`copyIn`):
//   - its real path (every link in its folders resolved) is strictly inside
//     the real path of one allowed root (the caller decides the roots: the
//     bot's repository, its task folders, its own folder); on Windows the
//     real path must also start with the root in its exact case;
//   - no folder between that root and the file is a link: the path as
//     written below the root is its real path;
//   - no path segment below that root is a protected file
//     (botRepoRead.ts BOT_REPO_SECRET_PATTERNS: `.env`, keys, `.git`, ...);
//   - the path itself is a regular file, not a link, a folder or a device,
//     and on Windows it names the file, not one of its data streams;
//   - the file has one name: a file with more than one (a hard link) may
//     hold the content of a file outside every root;
//   - it opens without following a link and the opened descriptor is the
//     same file (device and inode) that lstat saw, so a swap between the
//     check and the read is refused; after the read the real path is
//     checked again;
//   - it is at most MAX_BYTES and not empty, and the room's store stays
//     within ROOM_MAX_FILES and ROOM_MAX_BYTES (a full store refuses; it
//     never evicts).
//
// All IO is synchronous, as in the photo store (roomAttachments.ts).
// Retention: a stored file older than the room's retention plus a day that
// no kept card lists is swept (an open card outlives the retention), on
// start and at most hourly on a copy; while the cards cannot be read, none.
//
// The checks are path based (Node has no openat); the identity checks
// around the open back them up, and on Linux so does the opened
// descriptor's own path.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOM_LIMITS } from '../../shared/room';
import { ROOM_FILE_ID_RE, ROOM_FILE_LIMITS, type RoomFile } from '../../shared/roomFiles';
import { protectedPatternOf } from './botRepoRead';

export const ROOM_FILES_DIRNAME = 'room-files';

const DAY_MS = 24 * 3600_000;
/** A stored file older than this is swept: the room keeps no card longer. */
export const ROOM_FILE_RETAIN_MS = (ROOM_LIMITS.RETAIN_DAYS + 1) * DAY_MS;
const SWEEP_EVERY_MS = 3600_000;
const STORED_RE = /^[0-9a-f]{32}$/;
const TEMP_RE = /^[0-9a-f]{32}\.tmp$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** No link followed, and a FIFO swapped in for the file never blocks the
 *  open (main would hang); fstat then refuses anything but a file. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

const OCTET = 'application/octet-stream';
const TEXT = 'text/plain';
/** Media types by lower-case extension; anything else is octet-stream. */
const MEDIA_TYPES = new Map<string, string>(Object.entries({
  md: 'text/markdown', markdown: 'text/markdown',
  txt: TEXT, log: TEXT, text: TEXT,
  json: 'application/json',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  diff: 'text/x-diff', patch: 'text/x-diff',
  // Code and config: shown as text.
  ts: TEXT, tsx: TEXT, js: TEXT, jsx: TEXT, mjs: TEXT, cjs: TEXT, py: TEXT, rs: TEXT, go: TEXT,
  java: TEXT, kt: TEXT, swift: TEXT, rb: TEXT, php: TEXT, c: TEXT, h: TEXT, cc: TEXT, cpp: TEXT,
  hpp: TEXT, cs: TEXT, sh: TEXT, bash: TEXT, zsh: TEXT, ps1: TEXT, sql: TEXT, css: TEXT, scss: TEXT,
  xml: TEXT, yml: TEXT, yaml: TEXT, toml: TEXT, ini: TEXT, cfg: TEXT,
}));
const KNOWN_MEDIA_TYPES = new Set([OCTET, ...MEDIA_TYPES.values()]);

/** A Windows device name (CON, NUL, COM1, ...), with or without an extension. */
const WIN32_DEVICE_RE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
/** Characters a Windows file name cannot hold. */
const WIN32_RESERVED_RE = /[:*?"<>|]/;

/** Whether a Windows path names a data stream of a file (`a.txt:s`,
 *  `a.txt::$DATA`): a `:` past its drive or `\\?\` prefix. Pure. */
export function namesWin32Stream(p: string): boolean {
  const rest = p.replace(/^[\\/]{2}[?.][\\/](?:unc[\\/])?/i, '').replace(/^[A-Za-z]:/, '');
  return rest.includes(':');
}

/** Whether a file name cannot stand for itself on Windows: a reserved
 *  character (`:` would name a stream), a trailing dot or space (dropped by
 *  Windows), or a device name. Pure. */
export function isWin32UnsafeName(name: string): boolean {
  return WIN32_RESERVED_RE.test(name) || /[. ]$/.test(name) || WIN32_DEVICE_RE.test(name);
}

/** A file name's media type, by its extension. Pure. */
export function roomFileMediaType(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return OCTET;
  return MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase()) ?? OCTET;
}

/** Whether a stored file of this type is read back as UTF-8 text. Pure. */
export function isRoomFileText(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'image/svg+xml';
}

/** The name a card shows and Save a copy offers: the last path segment,
 *  without control characters, made a name Windows saves as itself (each
 *  reserved character becomes `_`, trailing dots and spaces go, a device
 *  name gets a leading `_`), trimmed to NAME_MAX. Empty when nothing is
 *  left. Pure. */
export function roomFileName(source: string): string {
  // eslint-disable-next-line no-control-regex
  const segment = (source.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  const base = windowsSafeName(segment);
  if (base.length <= ROOM_FILE_LIMITS.NAME_MAX) return base;
  // Keep the extension: it decides how the file is shown. The cut can end
  // in a dot or a space, so the shortened name is made safe again.
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
  return windowsSafeName(base.slice(0, ROOM_FILE_LIMITS.NAME_MAX - ext.length) + ext);
}

/** `name` with each reserved character as `_`, without trailing dots and
 *  spaces, and with a leading `_` on a device name. */
function windowsSafeName(name: string): string {
  const kept = name.replace(/[:*?"<>|]/g, '_').trim().replace(/[. ]+$/, '');
  return WIN32_DEVICE_RE.test(kept) ? `_${kept}` : kept;
}

/** A card's files read from disk or input, or undefined for none. Pure. */
export function parseRoomFiles(value: unknown): RoomFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RoomFile[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= ROOM_FILE_LIMITS.PER_CARD) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== 'string' || !ROOM_FILE_ID_RE.test(f.id) || seen.has(f.id)) continue;
    if (typeof f.name !== 'string' || !f.name || f.name.length > ROOM_FILE_LIMITS.NAME_MAX || CONTROL_RE.test(f.name) || /[\\/]/.test(f.name) || isWin32UnsafeName(f.name)) continue;
    if (typeof f.mediaType !== 'string' || !KNOWN_MEDIA_TYPES.has(f.mediaType)) continue;
    if (typeof f.bytes !== 'number' || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || f.bytes > ROOM_FILE_LIMITS.MAX_BYTES) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, mediaType: f.mediaType, bytes: f.bytes });
  }
  return out.length > 0 ? out : undefined;
}

/** Why a source was not taken. */
export type RoomFileRefusalReason = 'outside' | 'protected' | 'missing' | 'not_file' | 'stream' | 'links' | 'linked_folder' | 'size' | 'empty' | 'changed' | 'full' | 'store';

export type RoomFileCopy =
  | { ok: true; file: RoomFile }
  | { ok: false; reason: RoomFileRefusalReason; message: string };

const REFUSAL_TEXT: Record<RoomFileRefusalReason, string> = {
  outside: 'it is not inside your repository, one of your task folders or your bot folder',
  protected: 'it is a protected file (a secret, a key or git\'s own folder)',
  missing: 'there is no such file',
  not_file: 'it is not a regular file (a folder, a link or a device)',
  stream: 'it names a data stream of a file, not the file itself',
  links: 'it has more than one name on disk; attach a file with a single name',
  linked_folder: 'a folder on its path is a link; attach the file by its own path',
  size: `it is larger than ${ROOM_FILE_LIMITS.MAX_BYTES / (1024 * 1024)} MiB`,
  empty: 'it is empty',
  changed: 'it changed while it was being read',
  full: 'the room\'s file storage is full',
  store: 'the room\'s file storage could not be written',
};

function refuse(reason: RoomFileRefusalReason): { ok: false; reason: RoomFileRefusalReason; message: string } {
  return { ok: false, reason, message: REFUSAL_TEXT[reason] };
}

/** Read an open descriptor to its end, or null once it passes `max` bytes
 *  (a file that grows after its fstat is never read whole). */
function readBounded(fd: number, max: number): Buffer | null {
  const chunks: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    total += n;
    if (total > max) return null;
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
  return Buffer.concat(chunks, total);
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

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** `target` relative to `root` when strictly inside it, else null. Both are
 *  real paths. Windows compares paths without regard to case, yet a folder
 *  can be case-sensitive (WSL makes them so), where `REPO` is a sibling of
 *  `repo`; a real path gives each folder its on-disk case, so one truly
 *  inside starts with the root exactly. Pure. */
export function strictlyInside(root: string, target: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return null;
  if (platform === 'win32' && !target.startsWith(/[\\/]$/.test(root) ? root : `${root}${p.sep}`)) return null;
  return rel;
}

/**
 * Whether `source`, as written, reaches the file through no link below its
 * root: its path below one of the roots (as given, or resolved) is the real
 * path below the root that holds the file. Case-blind on macOS and Windows.
 */
function writtenWithoutLinks(allowedRoots: readonly string[], source: string, realRel: string): boolean {
  const written = path.resolve(source);
  const caseBlind = process.platform === 'darwin' || process.platform === 'win32';
  const same = (a: string, b: string) => (caseBlind ? a.toLowerCase() === b.toLowerCase() : a === b);
  return allowedRoots.filter((r) => path.isAbsolute(r)).some((root) => {
    for (const candidate of [path.resolve(root), realpathOrNull(root)]) {
      const rel = candidate ? strictlyInside(candidate, written) : null;
      if (rel !== null && same(rel, realRel)) return true;
    }
    return false;
  });
}

/** The real root `real` is strictly inside, with the path below it. */
function containingRoot(realRoots: readonly string[], real: string): { root: string; rel: string } | null {
  for (const root of realRoots) {
    const rel = strictlyInside(root, real);
    if (rel !== null) return { root, rel };
  }
  return null;
}

export interface RoomFileStoreOptions {
  /** `<wmuxDir>/factory/room-files` */
  root: string;
  /** The file ids the kept cards of a room list; null while the rooms are
   *  not readable (the sweep then deletes no stored file). An open card can
   *  outlive the room's retention, and its files stay with it. */
  referenced?: (workspaceId: string) => ReadonlySet<string> | null;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export class RoomFileStore {
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;
  private lastSweep = 0;
  /** Each room's held files and bytes: measured on its first copy, then kept
   *  by store and remove, and measured again after a sweep. */
  private readonly held = new Map<string, { files: number; bytes: number }>();

  constructor(private readonly opts: RoomFileStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m, e) => console.warn(`[factory] room files: ${m}`, e ?? ''));
  }

  /** A workspace's folder, or null for an id that is not one, or when the
   *  store or the folder is not a real directory (a link is never followed). */
  private dir(workspaceId: string): string | null {
    if (!WORKSPACE_ID_RE.test(workspaceId) || workspaceId === '.' || workspaceId === '..') return null;
    const dir = path.join(this.opts.root, workspaceId);
    return realDirOrAbsent(this.opts.root) && realDirOrAbsent(dir) ? dir : null;
  }

  /** Where a stored file is, or null for an id or workspace that is not one. */
  file(workspaceId: string, id: string): string | null {
    const dir = this.dir(workspaceId);
    return dir && ROOM_FILE_ID_RE.test(id) ? path.join(dir, id) : null;
  }

  /** The stored copy's bytes (read without following a link), or null. */
  read(workspaceId: string, id: string): Buffer | null {
    const file = this.file(workspaceId, id);
    if (!file) return null;
    let fd: number;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > ROOM_FILE_LIMITS.MAX_BYTES) return null;
      fd = fs.openSync(file, OPEN_FLAGS);
    } catch {
      return null;
    }
    try {
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.size > ROOM_FILE_LIMITS.MAX_BYTES) return null;
      return readBounded(fd, ROOM_FILE_LIMITS.MAX_BYTES);
    } catch {
      return null;
    } finally {
      try { fs.closeSync(fd); } catch { /* closed */ }
    }
  }

  /**
   * Copy one file a bot names into the room's store. `source` is absolute;
   * `allowedRoots` are absolute folders (a root that does not exist is
   * skipped). Refusals say why, in words a bot can act on.
   */
  copyIn(workspaceId: string, source: string, allowedRoots: readonly string[]): RoomFileCopy {
    if (!path.isAbsolute(source)) return refuse('missing');
    if (process.platform === 'win32' && namesWin32Stream(source)) return refuse('stream');
    const realRoots = allowedRoots
      .filter((r) => path.isAbsolute(r))
      .map(realpathOrNull)
      .filter((r): r is string => r !== null);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(source);
    } catch {
      return refuse('missing');
    }
    const real = realpathOrNull(source);
    if (!real) return refuse('missing');
    const inside = containingRoot(realRoots, real);
    if (!inside) return refuse('outside');
    if (protectedPatternOf(inside.rel)) return refuse('protected');
    if (!lst.isFile() || lst.isSymbolicLink()) return refuse('not_file');
    if (lst.nlink > 1) return refuse('links');
    if (!writtenWithoutLinks(allowedRoots, source, inside.rel)) return refuse('linked_folder');
    if (lst.size > ROOM_FILE_LIMITS.MAX_BYTES) return refuse('size');
    if (lst.size === 0) return refuse('empty');
    let data: Buffer | null;
    let fst: fs.Stats;
    let fd: number;
    try {
      fd = fs.openSync(real, OPEN_FLAGS);
    } catch {
      return refuse('changed');
    }
    try {
      fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino) return refuse('changed');
      if (fst.nlink > 1) return refuse('links');
      if (fst.size > ROOM_FILE_LIMITS.MAX_BYTES) return refuse('size');
      // Linux names the opened file itself: that path must be inside a root.
      if (process.platform === 'linux') {
        const opened = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (!containingRoot(realRoots, opened)) return refuse('changed');
      }
      data = readBounded(fd, ROOM_FILE_LIMITS.MAX_BYTES);
    } catch {
      return refuse('changed');
    } finally {
      try { fs.closeSync(fd); } catch { /* closed */ }
    }
    if (!data) return refuse('size');
    if (data.length === 0) return refuse('empty');
    // A folder above the file swapped for a link around the open is caught
    // here: the path must still resolve, inside a root, to the file read.
    const after = realpathOrNull(source);
    if (after !== real || !containingRoot(realRoots, after)) return refuse('changed');
    try {
      const now = fs.lstatSync(after);
      if (now.dev !== fst.dev || now.ino !== fst.ino) return refuse('changed');
    } catch {
      return refuse('changed');
    }
    const name = roomFileName(source);
    if (!name) return refuse('missing');
    return this.store(workspaceId, data, name);
  }

  private store(workspaceId: string, data: Buffer, name: string): RoomFileCopy {
    const dir = this.dir(workspaceId);
    if (!dir) return refuse('store');
    this.maybeSweep();
    const held = this.held.get(workspaceId) ?? this.measure(dir);
    if (held.files + 1 > ROOM_FILE_LIMITS.ROOM_MAX_FILES || held.bytes + data.length > ROOM_FILE_LIMITS.ROOM_MAX_BYTES) return refuse('full');
    const id = crypto.randomBytes(16).toString('hex');
    const final = path.join(dir, id);
    const temp = `${final}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Made just now or before: still a real folder of the store.
      if (!isRealDir(this.opts.root) || !isRealDir(dir)) throw new Error('the file folder is not a directory');
      fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, final);
      this.held.set(workspaceId, { files: held.files + 1, bytes: held.bytes + data.length });
    } catch (err) {
      try { fs.unlinkSync(temp); } catch { /* not written */ }
      this.log('a file was not stored', err);
      return refuse('store');
    }
    return { ok: true, file: { id, name, mediaType: roomFileMediaType(name), bytes: data.length } };
  }

  /** Remove stored files no card took (a post that was refused or repeated). */
  remove(workspaceId: string, ids: readonly string[]): void {
    for (const id of ids) {
      const file = this.file(workspaceId, id);
      if (!file) continue;
      try {
        const { size } = fs.lstatSync(file);
        fs.unlinkSync(file);
        const held = this.held.get(workspaceId);
        if (held) this.held.set(workspaceId, { files: held.files - 1, bytes: held.bytes - size });
      } catch { /* gone */ }
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
        bytes += fs.lstatSync(path.join(dir, name)).size;
        files += 1;
      } catch { /* vanished */ }
    }
    return { files, bytes };
  }

  private referencedIn(workspaceId: string): ReadonlySet<string> | null {
    try {
      return this.opts.referenced ? this.opts.referenced(workspaceId) : null;
    } catch (err) {
      this.log('the cards could not be read for the sweep', err);
      return null;
    }
  }

  private maybeSweep(): void {
    if (this.now() - this.lastSweep < SWEEP_EVERY_MS) return;
    this.sweep();
  }

  /** Delete stored files older than the room keeps a card that no kept card
   *  lists, and stray temporary files. Only names this store writes are
   *  touched. */
  sweep(): void {
    const now = this.now();
    this.lastSweep = now;
    this.held.clear();
    if (!isRealDir(this.opts.root)) return;
    let workspaces: string[] = [];
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
      let kept: ReadonlySet<string> | null | undefined;
      for (const name of names) {
        const stored = STORED_RE.test(name);
        if (!stored && !TEMP_RE.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const st = fs.lstatSync(file);
          const age = now - st.mtimeMs;
          if (!stored) {
            if (age > SWEEP_EVERY_MS) fs.unlinkSync(file);
            continue;
          }
          if (age <= ROOM_FILE_RETAIN_MS) continue;
          if (kept === undefined) kept = this.referencedIn(ws);
          if (kept && !kept.has(name)) fs.unlinkSync(file);
        } catch { /* vanished */ }
      }
    }
  }
}

let current: RoomFileStore | null = null;

/** The store the factory uses (set at factory start). */
export function setRoomFileStore(store: RoomFileStore | null): void {
  current = store;
}

export function getRoomFileStore(): RoomFileStore | null {
  return current;
}
