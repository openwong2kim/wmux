import type { Frame, Page } from 'playwright-core';
import {
  fetchResponseBody,
  tapPageNetwork,
  type CdpConsoleCall,
  type CdpLogEntry,
  type CdpRemoteObject,
  type NetRequest,
  type NetResponse,
} from './pageNetwork';

// ---------------------------------------------------------------------------
// Engine-side console / network capture for the Playwright transport (#1081).
//
// Collection starts when a page is first RESOLVED (open / navigate / attach),
// not when browser_console or browser_network is first called. The moment an
// agent reaches for the console is after something already looked wrong, so a
// buffer that starts filling at that call can never hold the load-time error,
// the uncaught exception, or the failed request that prompted the call.
//
// This module owns the buffers; PlaywrightEngine attaches, the inspection
// tools read. Keeping it below both avoids an engine -> tools import cycle.
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  level: string;
  text: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  response?: {
    headers: Record<string, string>;
    /** A small xhr/fetch body copied when it finished (see onFinished); anything else is fetched on demand. */
    body?: string;
  };
  /** Retained-body size, tracked so eviction can keep the budget accurate. */
  bodyBytes?: number;
  /** The CDP request id, by which browser_response_body asks Chrome for the body (pageNetwork). */
  requestId?: string;
  /** Playwright's resourceType spelling ('xhr', 'fetch', 'script', ...). */
  resourceType?: string;
  /** Loaded in full with a textual, non-streaming body, so Chrome can be asked for it. */
  bodyReadable?: boolean;
}

/**
 * When collection started for a page, and whether the page was already showing
 * content at that moment (so the caller can say what the buffer cannot cover
 * instead of letting an empty result read as "clean page").
 */
export interface CaptureWindow {
  since: number;
  missedBefore: boolean;
}

export interface PageCaptureState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** Per-kind, because clear:true is per-kind: clearing the console must not
   *  claim the network buffer only goes back that far. */
  consoleWindow: CaptureWindow;
  networkWindow: CaptureWindow;
  totalBodyBytes: number;
  /**
   * Requests that have started and not yet finished or failed, keyed by the
   * CDP request id with the ms timestamp of their start.
   *
   * Deliberately NOT a counter: a counter that only ever increments on
   * 'request' leaks on every aborted/failed load, and a page that lives for an
   * hour would then report permanent "in flight" traffic. Membership is the
   * truth, and readers additionally window it by recency
   * (countRecentPendingRequests) so a hung request cannot pin the signal on
   * forever either.
   */
  pendingRequests: Map<string, number>;
  /** The newest entry for each request id still in the ring, for its response and finish. */
  byRequestId: Map<string, NetworkEntry>;
}

// Bounds. Eager attachment means these buffers now fill on every page an agent
// touches, whether or not anything ever reads them, so an entry cap alone is
// not a memory bound: entry COUNT is capped here, and entry SIZE below.
const MAX_CAPTURE_ENTRIES = 1000;
// A page can log a megabyte in one console.log, and a data: URL can be
// megabytes on its own. Cap both so the ring's worst case is arithmetic.
const MAX_CONSOLE_TEXT_CHARS = 4096;
const MAX_URL_CHARS = 2048;
// Cap each retained response body, and the total, so 1000 entries cannot pin
// 1000 of them. Only small xhr/fetch bodies are retained at all (onFinished):
// they are what an agent reads after the page has moved on, and Chrome drops
// a session's bodies when the page navigates. Every other body stays in
// Chrome and is fetched on demand, capped to the same size in the answer.
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const MAX_TOTAL_BODY_BYTES = 4 * 1024 * 1024;
/** Resource types whose small bodies are copied as they finish. */
const RETAINED_BODY_TYPES = new Set(['xhr', 'fetch']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Unsettled requests tracked at once (insertion-ordered eviction).
const MAX_PENDING_REQUESTS = 500;

// Keyed by the Page object itself, not by surfaceId. A Page is the true
// identity: an omitted surfaceId and an explicit surfaceId can resolve to the
// SAME Page (one buffer, no stranding), and two DISTINCT Pages never collide
// on an alias key like '__default__' (so closing one page cannot delete
// another's data). WeakMap also lets a closed/GC'd Page drop its buffers.
const states = new WeakMap<Page, PageCaptureState>();

/**
 * Playwright reports a warning as 'warning'; the tool's `level` filter — and
 * main's CDP capture — both speak 'warn'. Without this remap, asking for
 * warnings on this transport quietly matches nothing.
 */
function mapConsoleLevel(type: string): string {
  return type === 'warning' ? 'warn' : type;
}

// Console text is rendered from the CDP events the way Playwright's
// ConsoleMessage.text() renders them, so the buffer reads the same as it did
// when it listened to page.on('console').

/** Playwright's sparseArrayToString: an array preview, holes and all. */
function sparseArrayToString(entries: Array<{ name: string; value?: string }>): string {
  const items: Array<{ index: number; value?: string }> = [];
  for (const { name, value } of entries) {
    const index = +name;
    if (isNaN(index) || index < 0) continue;
    items.push({ index, value });
  }
  items.sort((a, b) => a.index - b.index);
  let lastIndex = -1;
  const tokens: string[] = [];
  for (const { index, value } of items) {
    const emptyItems = index - lastIndex - 1;
    if (emptyItems === 1) tokens.push('empty');
    else if (emptyItems > 1) tokens.push(`empty x ${emptyItems}`);
    tokens.push(String(value));
    lastIndex = index;
  }
  return `[${tokens.join(', ')}]`;
}

/** Playwright's renderPreview, for an argument Chrome sent as an object. */
function renderPreview(object: CdpRemoteObject): string | undefined {
  if (object.type === 'undefined') return 'undefined';
  if ('value' in object) return String(object.value);
  if (object.unserializableValue) return String(object.unserializableValue);
  if (object.description === 'Object' && object.preview) {
    return `{${object.preview.properties.map(({ name, value }) => `${name}: ${value}`).join(', ')}}`;
  }
  if (object.subtype === 'array' && object.preview) return sparseArrayToString(object.preview.properties);
  return object.description;
}

/** One console argument, as Playwright's JSHandle preview reads at the time the message is emitted. */
function previewArg(arg: CdpRemoteObject): string {
  // An ElementHandle's preview is filled in later, by a page round trip.
  if (arg.subtype === 'node') return 'JSHandle@node';
  if (arg.objectId !== undefined) return renderPreview(arg) || `JSHandle@${arg.subtype || arg.type}`;
  if (arg.unserializableValue === undefined) return String(arg.value);
  // Playwright prints the parsed number, so -0 reads "0". A BigInt ("12n") it
  // parses to undefined and prints that; the literal is kept here instead.
  return arg.unserializableValue === '-0' ? '0' : arg.unserializableValue;
}

function isSetContentTag(call: CdpConsoleCall): boolean {
  const [only] = call.args ?? [];
  return call.args?.length === 1 && typeof only.value === 'string' && only.value.startsWith('--playwright--set--content--');
}

function consoleCallText(call: CdpConsoleCall): string {
  return (call.args ?? []).map(previewArg).join(' ');
}

/**
 * A copy of `value` that shares no storage with it. V8 makes a slice of a
 * long string a view onto the original, so a kept prefix of a 1MB data: URL
 * or a 4MB body would keep all of it alive.
 */
function detachedCopy(value: string): string {
  // A JSON round trip builds a new flat string, keeping one-byte text one-byte.
  return JSON.parse(JSON.stringify(value)) as string;
}

function truncate(value: string, max: number): string {
  return value.length > max
    ? detachedCopy(`${value.slice(0, max)} [truncated ${value.length - max} chars]`)
    : value;
}

/** Append to a capped ring: drop the oldest entries once the cap is exceeded. */
function pushConsole(state: PageCaptureState, entry: ConsoleEntry): void {
  state.console.push(entry);
  if (state.console.length > MAX_CAPTURE_ENTRIES) {
    state.console.splice(0, state.console.length - MAX_CAPTURE_ENTRIES);
  }
}

function pushNetwork(state: PageCaptureState, entry: NetworkEntry): void {
  state.network.push(entry);
  while (state.network.length > MAX_CAPTURE_ENTRIES) {
    const old = state.network.shift();
    if (!old) break;
    if (old.response?.body !== undefined) state.totalBodyBytes -= old.bodyBytes ?? 0;
    if (old.requestId !== undefined && state.byRequestId.get(old.requestId) === old) {
      state.byRequestId.delete(old.requestId);
    }
  }
}

/** Drop the oldest retained bodies (keeping their metadata) until under budget. */
function evictBodies(state: PageCaptureState): void {
  if (state.totalBodyBytes <= MAX_TOTAL_BODY_BYTES) return;
  for (const entry of state.network) {
    if (state.totalBodyBytes <= MAX_TOTAL_BODY_BYTES) break;
    if (entry.response?.body !== undefined) {
      state.totalBodyBytes -= entry.bodyBytes ?? 0;
      entry.bodyBytes = undefined;
      entry.response.body = undefined;
    }
  }
}

function capBody(body: string): string {
  return body.length > MAX_RESPONSE_BODY_BYTES
    ? detachedCopy(body.slice(0, MAX_RESPONSE_BODY_BYTES) + `\n... [truncated ${body.length - MAX_RESPONSE_BODY_BYTES} chars]`)
    : body;
}

/**
 * Whether browser_response_body answers with a response's body.
 *
 * Text only, as before: the tool returns text. A stream is textual but never
 * ends, so what Chrome holds of one is a fragment, not the response.
 */
function isRetainableTextBody(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/event-stream') || ct.includes('multipart/x-mixed-replace')) return false;
  return (
    ct.startsWith('text/') ||
    ct.includes('application/json') ||
    ct.includes('application/xml') ||
    ct.includes('application/xhtml') ||
    ct.includes('+json') ||
    ct.includes('+xml')
  );
}

/**
 * A page that already shows content when capture starts has a window this
 * buffer cannot cover — attaching to a tab that was open before the agent
 * arrived, for instance. Reported to the caller rather than hidden, because an
 * empty buffer with an unreported gap is what makes an agent say "no console
 * errors" about a page that threw on load.
 */
function pageAlreadyShowingContent(page: Page): boolean {
  try {
    const url = page.url();
    return url !== '' && url !== 'about:blank';
  } catch {
    return false;
  }
}

/**
 * Start capturing console messages and network activity for a page. Idempotent
 * per Page: a second call returns the existing buffers untouched, so a page
 * resolved by ten tool calls still has exactly one set of listeners (two would
 * record every message twice).
 */
export function attachPageCapture(page: Page): PageCaptureState {
  const existing = states.get(page);
  if (existing) return existing;

  const window: CaptureWindow = {
    since: Date.now(),
    missedBefore: pageAlreadyShowingContent(page),
  };
  const state: PageCaptureState = {
    console: [],
    network: [],
    consoleWindow: { ...window },
    networkWindow: { ...window },
    totalBodyBytes: 0,
    pendingRequests: new Map<string, number>(),
    byRequestId: new Map<string, NetworkEntry>(),
  };
  states.set(page, state);

  // Enabling Runtime on a session replays what the page logged before it: at
  // attach, and again when a session opens later (a retried open, a cross-site
  // iframe's new process). The buffer starts at its window, as it did with
  // page.on('console'), so a replay neither reaches back before attach nor
  // brings back what clear:true emptied.
  const beforeWindow = (timestamp: number | undefined) =>
    timestamp !== undefined && timestamp < state.consoleWindow.since;

  // Console messages come from the page's CDP sessions (pageNetwork), not
  // page.on('console'): that listener makes Playwright keep a JSHandle per
  // argument for the page's life. Each message is text here at once, and its
  // remote objects are released in Chrome.
  const onConsoleCall = (call: CdpConsoleCall) => {
    // Playwright drops these too: no execution context to attribute them to.
    if (call.executionContextId === 0 || beforeWindow(call.timestamp)) return;
    // Playwright's own setContent marker, which it swallowed before emitting.
    if (call.type === 'debug' && isSetContentTag(call)) return;
    pushConsole(state, {
      level: mapConsoleLevel(call.type),
      text: truncate(consoleCallText(call), MAX_CONSOLE_TEXT_CHARS),
    });
  };

  // Playwright routes an uncaught exception to 'pageerror', NOT to 'console' —
  // so without this the one thing #1081 is most often reached for, a page that
  // threw while loading, was still missing from an eagerly attached buffer.
  // It stays on Playwright: 'pageerror' carries a serialized Error and builds
  // no JSHandle, and it covers dedicated workers wherever Playwright can.
  const onPageError = (error: Error) => {
    const rendered = error.stack || `${error.name}: ${error.message}`;
    pushConsole(state, {
      level: 'error',
      text: truncate(`Uncaught ${rendered}`, MAX_CONSOLE_TEXT_CHARS),
    });
  };

  // What the browser logs itself ("Failed to load resource: ... 404"), which
  // Playwright's console carried too. A worker's are left out, as it did.
  const onLogEntry = (entry: CdpLogEntry) => {
    if (entry.source === 'worker' || beforeWindow(entry.timestamp)) return;
    pushConsole(state, {
      level: mapConsoleLevel(entry.level),
      text: truncate(entry.text, MAX_CONSOLE_TEXT_CHARS),
    });
  };

  // A new main-frame document retires the pre-attach gap: whatever this buffer
  // could not see belonged to the page that just went away, and claiming a gap
  // for the page now loaded would be its own kind of dishonesty.
  const onFrameNavigated = (frame: Frame) => {
    try {
      if (frame !== page.mainFrame()) return;
    } catch {
      return; // page torn down mid-event
    }
    state.consoleWindow.missedBefore = false;
    state.networkWindow.missedBefore = false;
  };

  const onRequest = (request: NetRequest) => {
    // Bound the map the same way the ring bounds entries: a page that starts
    // thousands of never-settling requests must not pin them all.
    if (!state.pendingRequests.has(request.requestId) && state.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      const oldest = state.pendingRequests.keys().next();
      if (!oldest.done) state.pendingRequests.delete(oldest.value);
    }
    state.pendingRequests.set(request.requestId, Date.now());
    const entry: NetworkEntry = {
      url: truncate(request.url, MAX_URL_CHARS),
      method: request.method,
      requestId: request.requestId,
      resourceType: request.resourceType,
    };
    pushNetwork(state, entry);
    state.byRequestId.set(request.requestId, entry);
  };

  const onResponse = (response: NetResponse) => {
    const entry = state.byRequestId.get(response.requestId);
    if (!entry) return;
    entry.status = response.status;
    entry.response = { headers: response.headers };
  };

  // Settlement. Both must clear the entry: finishing alone leaves every
  // blocked/aborted request pending forever.
  const onFinished = (requestId: string, encodedDataLength?: number) => {
    state.pendingRequests.delete(requestId);
    const entry = state.byRequestId.get(requestId);
    // A redirect hop also finishes here, and has no body of its own.
    if (!entry || REDIRECT_STATUSES.has(entry.status ?? 0)
      || !isRetainableTextBody(entry.response?.headers['content-type'] ?? '')) return;
    entry.bodyReadable = true;
    // A small xhr/fetch body is copied now, while Chrome still has it: the
    // page navigating away drops it there. A plain string under the caps
    // above; Playwright never sees the body, so it keeps no Buffer of it.
    if (!RETAINED_BODY_TYPES.has(entry.resourceType ?? '')) return;
    // A first cut on the wire size; the decoded length below is the real gate
    // (a compressed response can decode to many times this).
    if (encodedDataLength === undefined || encodedDataLength > MAX_RESPONSE_BODY_BYTES) return;
    void fetchResponseBody(page, requestId).then((result) => {
      // The state was dropped on close, the entry left the ring, or
      // clear:true replaced the array: charging a dead entry's bytes would
      // leak the budget, since evictBodies can no longer reach it.
      if (!('body' in result) || !entry.response || states.get(page) !== state) return;
      if (!state.network.includes(entry)) return;
      // Over the cap once decoded: not kept (a truncated copy would be a
      // partial answer anyway); browser_response_body asks Chrome for it.
      if (result.body.length > MAX_RESPONSE_BODY_BYTES) return;
      entry.response.body = result.body;
      entry.bodyBytes = entry.response.body.length;
      state.totalBodyBytes += entry.bodyBytes;
      evictBodies(state);
    }, () => undefined);
  };
  const onFailed = (requestId: string) => {
    state.pendingRequests.delete(requestId);
  };
  const tap = tapPageNetwork(page, {
    onRequest,
    onResponse,
    onFinished,
    onFailed,
    onConsoleCall,
    onLogEntry,
  });

  // The WeakMap would reclaim the buffers once the Page is GC'd, but the engine
  // may retain the Page object past close, so drop them on 'close' to free the
  // buffers promptly. The listeners come off with them: leaving them attached
  // would double-record everything if the same Page object is ever resolved
  // again (the WeakMap miss re-attaches), and would keep the old state alive
  // through the closures.
  const onClose = () => {
    states.delete(page);
    page.off('pageerror', onPageError);
    page.off('framenavigated', onFrameNavigated);
    tap.off();
    page.off('close', onClose);
  };

  page.on('close', onClose);
  page.on('pageerror', onPageError);
  page.on('framenavigated', onFrameNavigated);

  return state;
}

/** Read a page's capture state, attaching first if nothing is collecting yet. */
export function ensurePageCapture(page: Page): PageCaptureState {
  return states.get(page) ?? attachPageCapture(page);
}

/**
 * Reset the console buffer (browser_console clear:true). The window restarts:
 * "collecting since the clear" is the honest statement afterwards, and the
 * pre-attach gap is no longer what an empty result would be hiding.
 */
export function clearConsoleCapture(state: PageCaptureState): void {
  state.console = [];
  state.consoleWindow = { since: Date.now(), missedBefore: false };
}

/** Reset the network buffer (browser_network clear:true). */
export function clearNetworkCapture(state: PageCaptureState): void {
  state.network = [];
  state.totalBodyBytes = 0;
  state.byRequestId.clear();
  state.pendingRequests.clear();
  state.networkWindow = { since: Date.now(), missedBefore: false };
}

/**
 * How far back a pending request still counts as "in flight" for the snapshot
 * readiness hint. A long-poll or an EventSource stream never settles, so an
 * unwindowed count would report traffic on an idle page forever.
 */
export const PENDING_RECENCY_MS = 10_000;

/**
 * Requests started within PENDING_RECENCY_MS that have not settled.
 * Older entries are excluded from the count but kept in the map — the settle
 * events still own removal, and a slow request that finally responds must not
 * be double-counted.
 */
export function countRecentPendingRequests(
  state: PageCaptureState,
  now = Date.now(),
): number {
  let count = 0;
  for (const startedAt of state.pendingRequests.values()) {
    if (now - startedAt <= PENDING_RECENCY_MS) count++;
  }
  return count;
}

/**
 * Recent pending count for a page WITHOUT attaching capture to it.
 *
 * The snapshot readiness hint is a nice-to-have; attaching a capture buffer
 * (and its network session) merely to answer it would be a real cost
 * charged for a hint. Pages with no capture — every page on the builtin
 * backend — simply report 0, which the hint treats as "no extra signal".
 */
export function peekRecentPendingRequests(page: Page, now = Date.now()): number {
  const state = states.get(page);
  return state ? countRecentPendingRequests(state, now) : 0;
}

/** What browser_response_body gets for one captured entry. */
export type EntryBody = { body: string } | { unavailable: 'not-readable' | 'gone' };

/**
 * A captured entry's body: the retained copy when there is one, else asked of
 * Chrome now. A body fetched on demand is not cached, so reading one does not
 * keep it alive.
 */
export async function readEntryBody(page: Page, entry: NetworkEntry): Promise<EntryBody> {
  if (entry.response?.body !== undefined) return { body: entry.response.body };
  if (!entry.bodyReadable || entry.requestId === undefined) return { unavailable: 'not-readable' };
  const result = await fetchResponseBody(page, entry.requestId);
  if ('unavailable' in result) return { unavailable: 'gone' };
  return { body: capBody(result.body) };
}

/** Bounds, exported so tests assert the ring's contract rather than assume it. */
export const CAPTURE_BOUNDS = {
  MAX_CAPTURE_ENTRIES,
  MAX_CONSOLE_TEXT_CHARS,
  MAX_URL_CHARS,
  MAX_RESPONSE_BODY_BYTES,
  MAX_TOTAL_BODY_BYTES,
  MAX_PENDING_REQUESTS,
} as const;
