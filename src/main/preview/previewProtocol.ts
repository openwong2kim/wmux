// wmux-preview:// — serves the bytes of a local image or PDF to the preview
// tab (#2150), and tells that tab when the file settles after a change.
//
// URL shape: wmux-preview://<token>/<file name>?v=<version>
//
// Security properties:
//   - the renderer never puts a path in a URL. It asks to open a path over
//     IPC, main checks it (resolveAccessiblePath: no credential stores, real
//     path re-checked) and hands back a random 128-bit token. An unknown or
//     malformed token is a 404, so the scheme is not a file-read primitive.
//   - every request re-resolves the path and re-checks the extension on the
//     canonical path, so a symlink swapped after open is judged on its new
//     target. The bytes come from the same open handle that was fstat'ed:
//     only a regular file within the size cap is served (no FIFO, no
//     /dev/zero), and Content-Length is that same fstat's size.
//   - the handler is registered on the default session only. Browser
//     <webview>s all use `persist:wmux-*` / `wmux-*` partitions, so a web page
//     cannot even resolve this scheme. Never register it on a partition.
//   - responses are inert: nosniff, `default-src 'none'; sandbox`, no-store.
//     The packaged renderer is a file:// page (origin null), so pdf.js's
//     fetch is cross-origin and needs `Access-Control-Allow-Origin: *`; the
//     token is the only credential.

import { ipcMain, protocol, type CustomScheme, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { IPC } from '../../shared/constants';
import { sameFileId } from '../../shared/sameFileId';
import {
  looksComplete,
  PREVIEW_MAX_BYTES,
  PREVIEW_TAIL_BYTES,
  PREVIEW_PROTOCOL_SCHEME,
  PREVIEW_TOKEN_REGEX,
  previewTypeOf,
  type PreviewChangedEvent,
  type PreviewFileState,
  type PreviewKind,
  type PreviewOpenResult,
} from '../../shared/filePreview';
import { isNonLocalPath, isSensitivePath, resolveAccessiblePath } from '../ipc/handlers/fs.handler';

/** Registered together with the plugin scheme: see registerPrivilegedSchemes. */
export const PREVIEW_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: PREVIEW_PROTOCOL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

const RESPONSE_CSP = "default-src 'none'; sandbox";
const MAX_TOKENS_PER_SENDER = 64;
const MAX_WATCHED_DIRS = 64;
/** A change counts once size and mtime read the same twice this far apart. */
const SETTLE_MS = 150;
const SETTLE_MAX_ROUNDS = 40;
/** Backstop for watchers a platform silently drops (macOS on a removed dir). */
const POLL_MS = 2000;
/** How long a stable file may lack its end marker before it is shown anyway. */
const INCOMPLETE_GRACE_MS = 3000;
const REWATCH_MIN_MS = 500;
const REWATCH_MAX_MS = 8000;

interface Entry {
  token: string;
  requestedPath: string;
  dir: string;
  baseName: string;
  kind: PreviewKind;
  mime: string;
  sender: WebContents;
  state: PreviewFileState;
  /** The last check that was reported, for change detection. */
  last: FileStat;
  /** When the file was first seen stable but without its end marker. */
  incompleteSince: number | null;
  settling: boolean;
}

interface DirWatch {
  watcher: fs.FSWatcher | null;
  tokens: Set<string>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
}

const entries = new Map<string, Entry>();
const senderTokens = new Map<number, Set<string>>();
const hookedSenders = new WeakSet<WebContents>();
/** Bumps whenever a renderer's tokens are dropped, so an open that was in
 *  flight across a reload does not register for the page that is gone. */
const senderGeneration = new Map<number, number>();
const dirWatches = new Map<string, DirWatch>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** What a check of the file found. Identity (dev/ino/ctime) catches a swap
 *  that keeps the size and mtime, e.g. `cp -p` or an atomic rename. */
interface FileStat {
  exists: boolean;
  complete: boolean;
  size: number;
  mtimeMs: number;
  dev: bigint;
  ino: bigint;
  ctimeMs: number;
}

const MISSING: FileStat = { exists: false, complete: false, size: 0, mtimeMs: 0, dev: 0n, ino: 0n, ctimeMs: 0 };

/** The file identity is read from a bigint stat (a 64-bit file ID does not
 *  fit a Number); its times, as milliseconds, from the same stat. */
function fileStatOf(st: fs.BigIntStats, complete: boolean): FileStat {
  const ms = (ns: bigint): number => Number(ns) / 1e6;
  return { exists: true, complete, size: Number(st.size), mtimeMs: ms(st.mtimeNs), dev: st.dev, ino: st.ino, ctimeMs: ms(st.ctimeNs) };
}

async function readTail(canonical: string, size: number): Promise<Uint8Array> {
  const length = Math.min(size, PREVIEW_TAIL_BYTES);
  if (length === 0) return new Uint8Array();
  const handle = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function statFile(requestedPath: string): Promise<FileStat> {
  const canonical = await resolveAccessiblePath(requestedPath);
  if (!canonical) return MISSING;
  try {
    const st = await fs.promises.stat(canonical, { bigint: true });
    if (!st.isFile()) return MISSING;
    return fileStatOf(st, looksComplete(canonical, await readTail(canonical, Number(st.size))));
  } catch {
    return MISSING;
  }
}

function sameStat(a: FileStat, b: FileStat): boolean {
  return a.exists === b.exists && a.complete === b.complete && a.size === b.size && a.mtimeMs === b.mtimeMs
    && sameFileId(a, b) && a.ctimeMs === b.ctimeMs;
}

function publish(entry: Entry, stat: FileStat, complete: boolean): void {
  entry.state = { exists: stat.exists, complete, size: stat.size, mtimeMs: stat.mtimeMs, version: entry.state.version + 1 };
  if (entry.sender.isDestroyed()) return;
  const event: PreviewChangedEvent = { token: entry.token, ...entry.state };
  entry.sender.send(IPC.PREVIEW_CHANGED, event);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for the file to stop moving, then report it once if it changed. */
async function settle(entry: Entry): Promise<void> {
  if (entry.settling) return;
  entry.settling = true;
  try {
    let prev = await statFile(entry.requestedPath);
    for (let round = 0; round < SETTLE_MAX_ROUNDS; round++) {
      await sleep(SETTLE_MS);
      if (!entries.has(entry.token)) return;
      const next = await statFile(entry.requestedPath);
      if (sameStat(prev, next)) {
        if (sameStat(entry.last, next)) {
          // A file whose end marker never shows up but which has stopped
          // changing is taken as final (a format with data after its marker):
          // the view's decoder has the last word on it.
          if (next.exists && !entry.state.complete && entry.incompleteSince !== null
            && Date.now() - entry.incompleteSince >= INCOMPLETE_GRACE_MS) {
            entry.incompleteSince = null;
            publish(entry, next, true);
          }
          return;
        }
        entry.last = next;
        entry.incompleteSince = next.exists && !next.complete ? Date.now() : null;
        publish(entry, next, next.complete);
        return;
      }
      prev = next;
    }
  } finally {
    entry.settling = false;
  }
}

function notifyDir(dir: string, fileName: string | null): void {
  const watch = dirWatches.get(dir);
  if (!watch) return;
  for (const token of watch.tokens) {
    const entry = entries.get(token);
    // Some platforms report no file name: treat it as "maybe this file".
    if (entry && (fileName === null || fileName === entry.baseName)) void settle(entry);
  }
}

function startDirWatcher(dir: string, watch: DirWatch): void {
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, fileName) => {
      notifyDir(dir, fileName === null ? null : String(fileName));
    });
    const reattach = () => {
      if (watch.watcher !== watcher) return;
      watcher.close();
      watch.watcher = null;
      scheduleRewatch(dir, watch);
      notifyDir(dir, null);
    };
    watcher.on('error', reattach);
    watcher.on('close', reattach);
    watch.watcher = watcher;
    watch.retryDelay = REWATCH_MIN_MS;
  } catch {
    // The directory is missing (removed and not yet recreated): retry.
    scheduleRewatch(dir, watch);
  }
}

function scheduleRewatch(dir: string, watch: DirWatch): void {
  if (watch.retryTimer || watch.tokens.size === 0) return;
  watch.retryTimer = setTimeout(() => {
    watch.retryTimer = null;
    if (dirWatches.get(dir) !== watch) return;
    startDirWatcher(dir, watch);
    if (watch.watcher) notifyDir(dir, null);
  }, watch.retryDelay);
  watch.retryDelay = Math.min(watch.retryDelay * 2, REWATCH_MAX_MS);
}

function stopDirWatch(watch: DirWatch): void {
  if (watch.retryTimer) clearTimeout(watch.retryTimer);
  watch.retryTimer = null;
  const watcher = watch.watcher;
  watch.watcher = null;
  watcher?.close();
}

function ensurePolling(): void {
  if (entries.size === 0) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const entry of entries.values()) void settle(entry);
  }, POLL_MS);
  pollTimer.unref?.();
}

function release(token: string): void {
  const entry = entries.get(token);
  if (!entry) return;
  entries.delete(token);
  senderTokens.get(entry.sender.id)?.delete(token);
  const watch = dirWatches.get(entry.dir);
  if (watch) {
    watch.tokens.delete(token);
    if (watch.tokens.size === 0) {
      stopDirWatch(watch);
      dirWatches.delete(entry.dir);
    }
  }
  ensurePolling();
}

/** Other preview kinds (HTML, main/preview/previewHtml.ts) keep their own
 *  tokens and drop them on the same renderer lifecycle events. */
const senderReleaseListeners: Array<(senderId: number) => void> = [];

export function onSenderReleased(listener: (senderId: number) => void): void {
  senderReleaseListeners.push(listener);
}

/** Start following a renderer's lifecycle; returns its current generation. */
export function watchSender(sender: WebContents): number {
  trackSender(sender);
  return senderGeneration.get(sender.id) ?? 0;
}

/** True while `sender` is alive and has not navigated since `generation`. */
export function senderStillCurrent(sender: WebContents, generation: number): boolean {
  return !sender.isDestroyed() && (senderGeneration.get(sender.id) ?? 0) === generation;
}

interface KindHandler {
  open: (sender: WebContents, filePath: string) => Promise<PreviewOpenResult>;
  close: (sender: WebContents, token: string) => void;
}

let htmlHandler: KindHandler | null = null;

/** The HTML preview registers here, so one open/close IPC serves every kind. */
export function setHtmlPreviewHandler(handler: KindHandler): void {
  htmlHandler = handler;
}

function releaseSender(senderId: number): void {
  senderGeneration.set(senderId, (senderGeneration.get(senderId) ?? 0) + 1);
  for (const listener of senderReleaseListeners) listener(senderId);
  const tokens = senderTokens.get(senderId);
  if (!tokens) return;
  for (const token of [...tokens]) release(token);
  senderTokens.delete(senderId);
}

function trackSender(sender: WebContents): Set<string> {
  let tokens = senderTokens.get(sender.id);
  if (!tokens) {
    tokens = new Set();
    senderTokens.set(sender.id, tokens);
  }
  if (hookedSenders.has(sender)) return tokens;
  hookedSenders.add(sender);
  const senderId = sender.id;
  // A committed reload or new page starts a renderer that holds none of these
  // tokens. `did-navigate` fires only for a main-frame, cross-document commit,
  // so a navigation the window blocks (a file dropped on it) changes nothing.
  sender.on('did-navigate', () => releaseSender(senderId));
  sender.on('render-process-gone', () => releaseSender(senderId));
  sender.once('destroyed', () => {
    releaseSender(senderId);
    senderGeneration.delete(senderId);
  });
  return tokens;
}

export async function openPreview(sender: WebContents, filePath: unknown): Promise<PreviewOpenResult> {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096 || filePath.includes('\0')) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!path.isAbsolute(filePath)) return { ok: false, reason: 'unsupported' };
  const requested = previewTypeOf(filePath);
  if (!requested) return { ok: false, reason: 'unsupported' };
  if (requested.kind === 'html') {
    return htmlHandler ? htmlHandler.open(sender, filePath) : { ok: false, reason: 'unsupported' };
  }
  trackSender(sender);
  const generation = senderGeneration.get(sender.id) ?? 0;
  if (isSensitivePath(path.resolve(filePath))) return { ok: false, reason: 'denied' };
  const canonical = await resolveAccessiblePath(filePath);
  if (!canonical) {
    return { ok: false, reason: isNonLocalPath(filePath) || fs.existsSync(filePath) ? 'denied' : 'missing' };
  }
  // A symlink is judged, and typed, by what it points at.
  const actual = previewTypeOf(canonical);
  if (actual?.kind !== requested.kind) return { ok: false, reason: 'unsupported' };
  let st: fs.BigIntStats;
  try {
    st = await fs.promises.stat(canonical, { bigint: true });
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!st.isFile()) return { ok: false, reason: 'unsupported' };
  if (st.size > PREVIEW_MAX_BYTES[requested.kind]) return { ok: false, reason: 'too-large' };
  let complete = true;
  try {
    complete = looksComplete(canonical, await readTail(canonical, Number(st.size)));
  } catch {
    return { ok: false, reason: 'missing' };
  }
  // The page that asked may have reloaded or closed while we checked.
  if (sender.isDestroyed() || (senderGeneration.get(sender.id) ?? 0) !== generation) {
    return { ok: false, reason: 'missing' };
  }

  const tokens = trackSender(sender);
  const dir = path.dirname(canonical);
  if (tokens.size >= MAX_TOKENS_PER_SENDER) return { ok: false, reason: 'limit' };
  if (!dirWatches.has(dir) && dirWatches.size >= MAX_WATCHED_DIRS) return { ok: false, reason: 'limit' };

  const token = randomBytes(16).toString('hex');
  const last = fileStatOf(st, complete);
  const entry: Entry = {
    token,
    requestedPath: filePath,
    dir,
    baseName: path.basename(canonical),
    kind: actual.kind,
    mime: actual.mime,
    sender,
    state: { exists: true, complete, size: last.size, mtimeMs: last.mtimeMs, version: 1 },
    last,
    incompleteSince: complete ? null : Date.now(),
    settling: false,
  };
  entries.set(token, entry);
  tokens.add(token);
  let watch = dirWatches.get(dir);
  if (!watch) {
    watch = { watcher: null, tokens: new Set(), retryTimer: null, retryDelay: REWATCH_MIN_MS };
    dirWatches.set(dir, watch);
    startDirWatcher(dir, watch);
  }
  watch.tokens.add(token);
  ensurePolling();
  return { ok: true, token, kind: entry.kind, mime: entry.mime, ...entry.state };
}

export function closePreview(sender: WebContents, token: unknown): void {
  if (typeof token !== 'string') return;
  htmlHandler?.close(sender, token);
  const entry = entries.get(token);
  if (entry && entry.sender.id === sender.id) release(token);
}

const notFound = () => new Response('not found', { status: 404 });

export async function servePreview(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const token = url.hostname;
  if (!PREVIEW_TOKEN_REGEX.test(token)) return notFound();
  const entry = entries.get(token);
  if (!entry) return notFound();

  const canonical = await resolveAccessiblePath(entry.requestedPath);
  const type = canonical ? previewTypeOf(canonical) : null;
  if (!canonical || type?.kind !== entry.kind) return notFound();

  let handle: fs.promises.FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO for reading must not wait for a writer.
    // O_NOFOLLOW: the checked path is canonical, so a symlink here was swapped in.
    handle = await fs.promises.open(
      canonical,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return notFound();
  }
  let size: number;
  try {
    const st = await handle.stat({ bigint: true });
    // A folder above the file may have been swapped between the check and the
    // open: the handle must be the very file a fresh check lands on.
    const again = await resolveAccessiblePath(entry.requestedPath);
    const atPath = again === canonical ? await fs.promises.stat(again, { bigint: true }) : null;
    if (!st.isFile() || st.size > PREVIEW_MAX_BYTES[entry.kind]
      || !atPath || !sameFileId(atPath, st)) {
      await handle.close();
      return notFound();
    }
    size = Number(st.size);
  } catch {
    await handle.close().catch(() => undefined);
    return notFound();
  }

  const headers = new Headers({
    'content-type': type.mime,
    'content-length': String(size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-security-policy': RESPONSE_CSP,
    'access-control-allow-origin': '*',
  });
  if (size === 0) {
    await handle.close();
    return new Response(null, { status: 200, headers });
  }
  // Read exactly the bytes the fstat promised, from the handle it described.
  const stream = handle.createReadStream({ start: 0, end: size - 1 });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}

/** Register the scheme handler and the IPC. Must run after `app.whenReady()`
 *  and before the main renderer loads: a restored session opens previews at once. */
export function registerPreviewProtocol(): () => void {
  protocol.handle(PREVIEW_PROTOCOL_SCHEME, servePreview);
  ipcMain.removeHandler(IPC.PREVIEW_OPEN);
  ipcMain.handle(IPC.PREVIEW_OPEN, (event, filePath: unknown) => openPreview(event.sender, filePath));
  ipcMain.removeHandler(IPC.PREVIEW_CLOSE);
  ipcMain.handle(IPC.PREVIEW_CLOSE, (event, token: unknown) => closePreview(event.sender, token));
  return () => {
    ipcMain.removeHandler(IPC.PREVIEW_OPEN);
    ipcMain.removeHandler(IPC.PREVIEW_CLOSE);
    for (const senderId of [...senderTokens.keys()]) releaseSender(senderId);
  };
}

/** Test seam: what is open and watched right now. */
export function previewStatsForTests(): { tokens: number; watchedDirs: number; polling: boolean } {
  return { tokens: entries.size, watchedDirs: dirWatches.size, polling: pollTimer !== null };
}
