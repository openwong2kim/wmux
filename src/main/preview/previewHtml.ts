// HTML preview: renders a local .html file and the files beside it in a
// sandboxed <webview>, never in the app renderer.
//
// URL shape: wmux-html://<token>/<path inside the root>
//
// Security properties (a page in a cloned repo is untrusted code):
//   - the scheme is handled ONLY on the `preview-html` partition. The app
//     renderer and the browser panes (persist:wmux-* / wmux-*) cannot resolve
//     it; their sessions answer ERR_UNKNOWN_URL_SCHEME.
//   - a token's root is the page's git worktree, or its folder outside one.
//     The home folder itself, a filesystem root and a credential store are
//     never roots. Every request is resolved inside the root by real path,
//     refuses dot-paths (.env, .git, …) below the page's own folder chain,
//     and serves only a regular file within the size cap, from the handle it
//     checked (O_NOFOLLOW, dev/inode re-check), with nosniff and no-store.
//   - the page is offline by default, enforced by the session, not by hooks
//     that miss traffic: the `preview-html` session's proxy is a closed port
//     (loopback included), WebRTC may use only proxied UDP, http(s)/ws(s)
//     requests are cancelled as well, and pages ask for no DNS prefetch. A tab
//     whose person allowed the network remounts on `preview-html-online`,
//     which serves a token's files only while that allowance holds.
//   - the page never leaves its origin: top-level navigations and popups are
//     refused, and an http(s) link is handed to the tab, which shows it for
//     the person to open (never opened automatically). Sub-frames may load
//     about:, blob:, data: and the same token's files only.
//   - permissions are denied except clipboard writes and fullscreen;
//     downloads are cancelled.

import { app, ipcMain, session, type CustomScheme, type Session, type WebContents } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { IPC } from '../../shared/constants';
import { sameFileId } from '../../shared/sameFileId';
import {
  HTML_PREVIEW_ONLINE_PARTITION,
  HTML_PREVIEW_PARTITION,
  HTML_PREVIEW_SCHEME,
  PREVIEW_MAX_BYTES,
  PREVIEW_TOKEN_REGEX,
  htmlAssetMime,
  htmlPreviewToken,
  type PreviewChangedEvent,
  type PreviewLinkEvent,
  type PreviewOpenResult,
} from '../../shared/filePreview';
import { isNonLocalPath, isSensitivePath, resolveAccessiblePath } from '../ipc/handlers/fs.handler';
import { onSenderReleased, senderStillCurrent, setHtmlPreviewHandler, watchSender } from './previewProtocol';

/** Registered with every other privileged scheme in one call (privilegedSchemes.ts). */
export const HTML_PREVIEW_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: HTML_PREVIEW_SCHEME,
  // standard: relative URLs resolve inside the page. secure: a secure context
  // (crypto.subtle, clipboard). supportFetchAPI: reports fetch their data.
  // No corsEnabled, serviceWorkers, bypassCSP or codeCache.
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
};

const MAX_TOKENS_PER_SENDER = 32;
/** Quiet time after the last change in the folder before the page reloads. */
const SETTLE_MS = 300;
const POLL_MS = 2000;
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const MAX_SERVED_TRACKED = 2000;
/** Offline responses also tell the page it may load nothing but its own files. */
const OFFLINE_CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:";

interface HtmlEntry {
  token: string;
  requestedPath: string;
  /** Real path of the root every request must stay inside. */
  root: string;
  /** The page, relative to the root, `/`-separated. */
  page: string;
  /** Leading segments of the page's folder: dot-names there are allowed. */
  pageDirSegments: string[];
  /** The folder watched for changes (the root, or the page's folder on Linux). */
  watchDir: string;
  /** Real paths this page has loaded: only their changes reload it. */
  served: Set<string>;
  sender: WebContents;
  version: number;
  exists: boolean;
  size: number;
  mtimeMs: number;
  network: boolean;
  watcher: fs.FSWatcher | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, HtmlEntry>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let offlineSession: Session | null = null;
let onlineSession: Session | null = null;

const caseInsensitiveFs = process.platform === 'darwin' || process.platform === 'win32';

function sameOrInside(root: string, target: string): boolean {
  const rel = path.relative(caseInsensitiveFs ? root.toLowerCase() : root, caseInsensitiveFs ? target.toLowerCase() : target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isHomeOrFsRoot(dir: string): boolean {
  const norm = (p: string) => (caseInsensitiveFs ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const home = os.homedir();
  let realHome = home;
  try { realHome = fs.realpathSync.native(home); } catch { /* keep the given spelling */ }
  const d = norm(dir);
  return d === norm(home) || d === norm(realHome) || norm(path.parse(dir).root) === d;
}

/** The nearest folder at or above `dir` that holds a `.git` entry. */
function findGitRoot(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** For a page inside node_modules: its own package folder (`@scope/pkg` too). */
function packageRoot(pageDir: string): string | null {
  const parts = pageDir.split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1 || at + 1 >= parts.length) return null;
  const take = parts[at + 1].startsWith('@') && at + 2 < parts.length ? at + 3 : at + 2;
  return parts.slice(0, take).join(path.sep) || null;
}

/**
 * The page's git worktree, or its folder; never home, a filesystem root or a
 * credential store. A page shipped inside node_modules is third-party: it gets
 * only its package's folder, not the project around it.
 */
export function chooseHtmlRoot(pageDir: string): string | null {
  const pkg = packageRoot(pageDir);
  const candidates = (pkg ? [pkg, pageDir] : [findGitRoot(pageDir), pageDir]).filter((c): c is string => c !== null);
  for (const candidate of candidates) {
    if (!isHomeOrFsRoot(candidate) && !isSensitivePath(candidate)) return candidate;
  }
  return null;
}

async function statPage(entry: HtmlEntry): Promise<{ exists: boolean; size: number; mtimeMs: number }> {
  const canonical = await resolveAccessiblePath(entry.requestedPath);
  if (!canonical) return { exists: false, size: 0, mtimeMs: 0 };
  try {
    const st = await fs.promises.stat(canonical);
    return st.isFile() ? { exists: true, size: st.size, mtimeMs: st.mtimeMs } : { exists: false, size: 0, mtimeMs: 0 };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

/** Something in the folder changed: once it has been quiet, tell the tab to reload. */
function scheduleReload(entry: HtmlEntry): void {
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.settleTimer = setTimeout(() => {
    entry.settleTimer = null;
    void statPage(entry).then((st) => {
      if (!entries.has(entry.token)) return;
      Object.assign(entry, st);
      entry.version += 1;
      if (entry.sender.isDestroyed()) return;
      const event: PreviewChangedEvent = {
        token: entry.token, exists: st.exists, complete: true, size: st.size, mtimeMs: st.mtimeMs, version: entry.version,
      };
      entry.sender.send(IPC.PREVIEW_CHANGED, event);
    });
  }, SETTLE_MS);
}

function startWatcher(entry: HtmlEntry): void {
  try {
    // Recursive where the OS watches a tree natively (macOS FSEvents, Windows);
    // Linux would walk the tree with one inotify watch per folder.
    const recursive = process.platform === 'darwin' || process.platform === 'win32';
    const watcher = fs.watch(entry.watchDir, { persistent: false, recursive }, (_event, fileName) => {
      // Only a file the page actually loaded counts; an agent working in the
      // rest of the repo (.git, caches, other sources) never reloads it.
      if (fileName === null || entry.served.has(path.join(entry.watchDir, String(fileName)))) scheduleReload(entry);
    });
    watcher.on('error', () => {
      watcher.close();
      if (entry.watcher === watcher) entry.watcher = null;
    });
    entry.watcher = watcher;
  } catch {
    entry.watcher = null;
  }
}

/** Backstop: the page itself changed (or a dropped watcher came back). */
function ensurePolling(): void {
  if (entries.size === 0) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const entry of entries.values()) {
      void statPage(entry).then((st) => {
        if (!entries.has(entry.token)) return;
        if (!entry.watcher && st.exists) startWatcher(entry);
        if (st.exists !== entry.exists || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) scheduleReload(entry);
      });
    }
  }, POLL_MS);
  pollTimer.unref?.();
}

function release(token: string): void {
  const entry = entries.get(token);
  if (!entry) return;
  entries.delete(token);
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.watcher?.close();
  ensurePolling();
}

export async function openHtmlPreview(sender: WebContents, filePath: string): Promise<PreviewOpenResult> {
  const generation = watchSender(sender);
  if (isSensitivePath(path.resolve(filePath))) return { ok: false, reason: 'denied' };
  const canonical = await resolveAccessiblePath(filePath);
  if (!canonical) return { ok: false, reason: isNonLocalPath(filePath) || fs.existsSync(filePath) ? 'denied' : 'missing' };
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(canonical);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!st.isFile()) return { ok: false, reason: 'unsupported' };
  if (st.size > PREVIEW_MAX_BYTES.html) return { ok: false, reason: 'too-large' };
  const pageDir = path.dirname(canonical);
  const root = chooseHtmlRoot(pageDir);
  if (!root) return { ok: false, reason: 'denied' };
  if (!senderStillCurrent(sender, generation)) return { ok: false, reason: 'missing' };
  const owned = [...entries.values()].filter((e) => e.sender.id === sender.id).length;
  if (owned >= MAX_TOKENS_PER_SENDER) return { ok: false, reason: 'limit' };

  // The folder by its real path, the file by the name that was opened: a
  // `latest.html` symlink is followed on every request, so retargeting it
  // shows the new page (still only if it resolves inside the root).
  const opened = path.join(pageDir, path.basename(filePath));
  const page = path.relative(root, sameOrInside(root, opened) ? opened : canonical).split(path.sep).join('/');
  const token = randomBytes(16).toString('hex');
  const entry: HtmlEntry = {
    token,
    requestedPath: filePath,
    root,
    page,
    pageDirSegments: page.split('/').slice(0, -1),
    // The whole root where the OS watches a tree natively; the page's folder on Linux.
    watchDir: process.platform === 'darwin' || process.platform === 'win32' ? root : pageDir,
    served: new Set([canonical]),
    sender,
    version: 1,
    exists: true,
    size: st.size,
    mtimeMs: st.mtimeMs,
    network: false,
    watcher: null,
    settleTimer: null,
  };
  entries.set(token, entry);
  startWatcher(entry);
  ensurePolling();
  return {
    ok: true, token, kind: 'html', mime: 'text/html; charset=utf-8', path: page,
    exists: true, complete: true, size: st.size, mtimeMs: st.mtimeMs, version: 1,
  };
}

export function closeHtmlPreview(sender: WebContents, token: string): void {
  const entry = entries.get(token);
  if (entry && entry.sender.id === sender.id) release(token);
}

export function setHtmlPreviewNetwork(sender: WebContents, token: unknown, allowed: unknown): boolean {
  if (typeof token !== 'string' || typeof allowed !== 'boolean') return false;
  const entry = entries.get(token);
  if (!entry || entry.sender.id !== sender.id) return false;
  entry.network = allowed;
  return true;
}

const notFound = () => new Response('not found', { status: 404 });

/**
 * Resolve a request path inside the entry's root. Returns the real path of a
 * file or folder that may be served, or null. Exported for tests: URL
 * normalisation already strips `..`, so the guard is tested on raw paths.
 */
export async function resolveInsideRoot(entry: Pick<HtmlEntry, 'root' | 'pageDirSegments'>, rawPath: string): Promise<string | null> {
  if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.includes(':')) return null;
  const segments = rawPath.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) return null;
  const joined = path.join(entry.root, ...segments);
  if (!sameOrInside(entry.root, joined)) return null;
  // Canonicalized by resolveAccessiblePath, which spelled the page's folder the
  // root was chosen from (openHtmlPreview), so both are in one path space: on a
  // mapped network drive a bare realpath answers the share's UNC spelling
  // (\\server\share\…), while the root is spelled from the drive (Z:\…), and
  // nothing on the drive would be inside it (#3413).
  const real = await resolveAccessiblePath(joined);
  if (!real) return null;
  if (!sameOrInside(entry.root, real) || isSensitivePath(real)) return null;
  // No dot-names (.env, .git, …), judged on the real path, except along the
  // page's own folder chain (a page under .github/ may load its neighbours).
  const relSegments = path.relative(entry.root, real).split(path.sep).filter(Boolean);
  for (let i = 0; i < relSegments.length; i++) {
    const allowedHere = i < entry.pageDirSegments.length && relSegments[i] === entry.pageDirSegments[i];
    if (relSegments[i].startsWith('.') && !allowedHere) return null;
  }
  return real;
}

export async function serveHtmlPreview(request: Request, online = false): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const token = url.hostname;
  if (!PREVIEW_TOKEN_REGEX.test(token)) return notFound();
  const entry = entries.get(token);
  // The online session serves a token only while its tab allows the network.
  if (!entry || (online && !entry.network)) return notFound();
  let rawPath: string;
  try {
    rawPath = decodeURIComponent(url.pathname);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  let servedRaw = rawPath;
  let real = await resolveInsideRoot(entry, servedRaw);
  if (!real) return notFound();

  let st: fs.Stats;
  try {
    st = await fs.promises.stat(real);
  } catch {
    return notFound();
  }
  if (st.isDirectory()) {
    // A folder URL without its slash would resolve the page's relative links one level up.
    if (!url.pathname.endsWith('/')) {
      return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}` } });
    }
    servedRaw = `${rawPath}/index.html`;
    real = await resolveInsideRoot(entry, servedRaw);
    if (!real) return notFound();
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return notFound();
  }
  let size: number;
  try {
    const opened = await handle.stat({ bigint: true });
    // A folder above the file may have been swapped between the check and the
    // open: resolve the request again and require the very file we hold.
    const again = await resolveInsideRoot(entry, servedRaw);
    const atPath = again === real ? await fs.promises.stat(again, { bigint: true }) : null;
    if (!opened.isFile() || opened.size > PREVIEW_MAX_BYTES.html || !atPath || !sameFileId(atPath, opened)) {
      await handle.close();
      return notFound();
    }
    size = Number(opened.size);
  } catch {
    await handle.close().catch(() => undefined);
    return notFound();
  }
  const headers = new Headers({
    'content-type': htmlAssetMime(real),
    'content-length': String(size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'x-dns-prefetch-control': 'off',
  });
  if (!online) headers.set('content-security-policy', OFFLINE_CSP);
  if (size === 0 || request.method === 'HEAD') {
    await handle.close();
    return new Response(null, { status: 200, headers });
  }
  if (entry.served.size < MAX_SERVED_TRACKED) entry.served.add(real);
  const stream = handle.createReadStream({ start: 0, end: size - 1 });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}

/** Where a previewed page may navigate a frame. */
export function htmlNavigationVerdict(fromUrl: string, toUrl: string, isMainFrame: boolean): 'allow' | 'deny' | 'hand-off' {
  const fromToken = htmlPreviewToken(fromUrl);
  const toToken = htmlPreviewToken(toUrl);
  if (fromToken && toToken === fromToken) return 'allow';
  let scheme = '';
  try {
    scheme = new URL(toUrl).protocol;
  } catch {
    return 'deny';
  }
  if (!isMainFrame && (scheme === 'about:' || scheme === 'blob:' || scheme === 'data:')) return 'allow';
  if (scheme === 'http:' || scheme === 'https:') return 'hand-off';
  return 'deny';
}

export function isHtmlPreviewContents(contents: WebContents): boolean {
  return contents.session === offlineSession || contents.session === onlineSession;
}

function handOffLink(guest: WebContents, url: string): void {
  const token = htmlPreviewToken(guest.getURL());
  const host = guest.hostWebContents;
  if (!token || !host || host.isDestroyed()) return;
  const entry = entries.get(token);
  if (!entry || entry.sender.id !== host.id) return;
  const event: PreviewLinkEvent = { token, url };
  host.send(IPC.PREVIEW_LINK, event);
}

function guardGuest(contents: WebContents): void {
  // WebRTC may not open its own UDP sockets; offline, the proxy refuses the rest.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.setWindowOpenHandler(({ url }) => {
    if (htmlNavigationVerdict(contents.getURL(), url, true) === 'hand-off') handOffLink(contents, url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    const verdict = htmlNavigationVerdict(contents.getURL(), event.url, true);
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'hand-off') handOffLink(contents, event.url);
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return; // will-navigate above
    if (htmlNavigationVerdict(contents.getURL(), event.url, false) !== 'allow') event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (htmlNavigationVerdict(contents.getURL(), event.url, event.isMainFrame) !== 'allow') event.preventDefault();
  });
}

/** Shared by both preview sessions: what a page may do besides load its files. */
function lockDownSession(ses: Session, online: boolean): void {
  ses.protocol.handle(HTML_PREVIEW_SCHEME, (request) => serveHtmlPreview(request, online));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.on('will-download', (event) => event.preventDefault());
}

/** Must run after `app.whenReady()` and before the main renderer loads. */
export function registerHtmlPreview(): void {
  const offline = session.fromPartition(HTML_PREVIEW_PARTITION);
  const online = session.fromPartition(HTML_PREVIEW_ONLINE_PARTITION);
  offlineSession = offline;
  onlineSession = online;
  // These two sessions, and only these, can resolve wmux-html:.
  lockDownSession(offline, false);
  lockDownSession(online, true);
  // Offline means the network stack has nowhere to go: every connection,
  // loopback included, is sent to a closed port, and the hooks that do see
  // requests cancel them too.
  void offline.setProxy({ proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' });
  offline.enableNetworkEmulation({ offline: true });
  offline.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
    callback({ cancel: true });
  });
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview' && isHtmlPreviewContents(contents)) guardGuest(contents);
  });
  onSenderReleased((senderId) => {
    for (const entry of [...entries.values()]) if (entry.sender.id === senderId) release(entry.token);
  });
  setHtmlPreviewHandler({ open: openHtmlPreview, close: closeHtmlPreview });
  ipcMain.removeHandler(IPC.PREVIEW_SET_NETWORK);
  ipcMain.handle(IPC.PREVIEW_SET_NETWORK, (event, token: unknown, allowed: unknown) => setHtmlPreviewNetwork(event.sender, token, allowed));
}

/** Test seam. */
export function htmlPreviewStatsForTests(): { tokens: number; polling: boolean } {
  return { tokens: entries.size, polling: pollTimer !== null };
}
