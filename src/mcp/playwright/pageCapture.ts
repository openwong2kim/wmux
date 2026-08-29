import type { ConsoleMessage, Frame, Page, Request, Response } from 'playwright-core';

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
    body?: string;
  };
  /** Retained-body size, tracked so eviction can keep the budget accurate. */
  bodyBytes?: number;
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
}

// Bounds. Eager attachment means these buffers now fill on every page an agent
// touches, whether or not anything ever reads them, so an entry cap alone is
// not a memory bound: entry COUNT is capped here, and entry SIZE below.
const MAX_CAPTURE_ENTRIES = 1000;
// A page can log a megabyte in one console.log, and a data: URL can be
// megabytes on its own. Cap both so the ring's worst case is arithmetic.
const MAX_CONSOLE_TEXT_CHARS = 4096;
const MAX_URL_CHARS = 2048;
// Cap each retained response body so a single large payload cannot pin
// unbounded RAM, and cap the total so 1000 entries cannot pin 1000 of them.
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const MAX_TOTAL_BODY_BYTES = 4 * 1024 * 1024;

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

function truncate(value: string, max: number): string {
  return value.length > max
    ? `${value.slice(0, max)} [truncated ${value.length - max} chars]`
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

/**
 * Whether a response body is worth reading into the buffer.
 *
 * A stream is textual but never ENDS: response.text() on an SSE or
 * multipart/x-mixed-replace response settles only when the stream closes, so
 * the pending promise pins the entry, the state and the page for as long as
 * the stream runs. That was survivable while capture started on the first
 * read; eager attachment widens the target from "a page someone called
 * browser_network on" to "every page an agent touches", so streams are
 * excluded rather than gambled on.
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
  };
  states.set(page, state);

  const onConsole = (msg: ConsoleMessage) => {
    pushConsole(state, {
      level: mapConsoleLevel(msg.type()),
      text: truncate(msg.text(), MAX_CONSOLE_TEXT_CHARS),
    });
  };

  // Playwright routes an uncaught exception to 'pageerror', NOT to 'console' —
  // so without this the one thing #1081 is most often reached for, a page that
  // threw while loading, was still missing from an eagerly attached buffer.
  const onPageError = (error: Error) => {
    const rendered = error.stack || `${error.name}: ${error.message}`;
    pushConsole(state, {
      level: 'error',
      text: truncate(`Uncaught ${rendered}`, MAX_CONSOLE_TEXT_CHARS),
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

  const onRequest = (request: Request) => {
    pushNetwork(state, {
      url: truncate(request.url(), MAX_URL_CHARS),
      method: request.method(),
    });
  };

  const onResponse = (response: Response) => {
    const url = truncate(response.url(), MAX_URL_CHARS);
    // Find the matching request entry (last one with same URL and no status yet)
    for (let i = state.network.length - 1; i >= 0; i--) {
      if (state.network[i].url !== url || state.network[i].status !== undefined) continue;
      // Capture a stable reference to the entry object: the capture array is a
      // capped ring (pushNetwork), so positional indices can shift while the
      // async response.text() below is in flight.
      const entry = state.network[i];
      entry.status = response.status();
      const headers = response.headers();
      entry.response = { headers };
      // Only eagerly capture body for text-based, non-streaming content types
      if (isRetainableTextBody(headers['content-type'] ?? '')) {
        response
          .text()
          .then((body) => {
            // Three ways this entry can be dead by now, and charging its bytes
            // to the budget in any of them leaks the budget permanently: the
            // state was dropped on close, the entry was shifted out of the
            // ring, or clear:true replaced the array. `includes` covers the
            // last two — a dead entry is not reachable from state.network, so
            // evictBodies could never reclaim its bytes either, and the budget
            // would drift until eviction started dropping LIVE bodies and
            // browser_response_body answered "not found" forever.
            if (!entry.response || states.get(page) !== state) return;
            if (!state.network.includes(entry)) return;
            entry.response.body =
              body.length > MAX_RESPONSE_BODY_BYTES
                ? body.slice(0, MAX_RESPONSE_BODY_BYTES) +
                  `\n... [truncated ${body.length - MAX_RESPONSE_BODY_BYTES} chars]`
                : body;
            entry.bodyBytes = entry.response.body.length;
            state.totalBodyBytes += entry.bodyBytes;
            evictBodies(state);
          })
          .catch(() => {
            // Body may not be available for all responses
          });
      }
      break;
    }
  };

  // The WeakMap would reclaim the buffers once the Page is GC'd, but the engine
  // may retain the Page object past close, so drop them on 'close' to free the
  // (potentially large) retained response bodies promptly. The listeners come
  // off with them: leaving them attached would double-record everything if the
  // same Page object is ever resolved again (the WeakMap miss re-attaches), and
  // would keep the old state — retained bodies included — alive through the
  // closures.
  const onClose = () => {
    states.delete(page);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('framenavigated', onFrameNavigated);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('close', onClose);
  };

  page.on('close', onClose);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('framenavigated', onFrameNavigated);
  page.on('request', onRequest);
  page.on('response', onResponse);

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

/** Reset the network buffer and its retained bodies (browser_network clear:true). */
export function clearNetworkCapture(state: PageCaptureState): void {
  state.network = [];
  state.totalBodyBytes = 0;
  state.networkWindow = { since: Date.now(), missedBefore: false };
}

/** Bounds, exported so tests assert the ring's contract rather than assume it. */
export const CAPTURE_BOUNDS = {
  MAX_CAPTURE_ENTRIES,
  MAX_CONSOLE_TEXT_CHARS,
  MAX_URL_CHARS,
  MAX_RESPONSE_BODY_BYTES,
  MAX_TOTAL_BODY_BYTES,
} as const;
