import type { CDPSession, Page } from 'playwright-core';

// ---------------------------------------------------------------------------
// One CDP Network session per page, shared by everything engine-side that
// watches a page's traffic (pageCapture's network buffer, actionSettle's
// request rhythm and settle wait).
//
// Why not page.on('request' | 'response' | ...): a listener for any of those
// makes Playwright build a client-side Request/Response object for every
// request the page makes, and keep it for as long as the page lives. Reading a
// body through one (response.text()) also caches the raw Buffer on it. A
// long-lived MCP process driving a busy SPA grew to 760MB that way, with the
// buffers wmux itself kept capped at a few MB. The Network domain on a CDP
// session hands over plain event objects and keeps nothing on this side;
// bodies stay in Chrome's own buffer (bounded by NETWORK_BUFFER below) and are
// fetched only when a caller asks for one.
//
// Coverage is the page's own target: requests from cross-site iframes that run
// in their own process (OOPIFs) and from workers are not seen here.
// ---------------------------------------------------------------------------

/** A request start, in the shape the watchers read. */
export interface NetRequest {
  requestId: string;
  url: string;
  method: string;
  /** Playwright's resourceType spelling: 'document', 'script', 'xhr', 'fetch', ... */
  resourceType: string;
  /** A document request that starts a navigation (of any frame). */
  navigation: boolean;
  /** Issued for the page's main frame. */
  mainFrame: boolean;
}

export interface NetResponse {
  requestId: string;
  url: string;
  status: number;
  /** Lower-cased names, as Playwright's response.headers() has them. */
  headers: Record<string, string>;
}

export interface NetworkTapListener {
  onRequest?: (request: NetRequest) => void;
  onResponse?: (response: NetResponse) => void;
  /** Loaded in full, or redirected (the next hop starts as a new request with the same id). */
  onFinished?: (requestId: string) => void;
  onFailed?: (requestId: string) => void;
}

export interface NetworkTap {
  /** True once the session is listening; false when the page has no usable CDP session. */
  readonly ready: Promise<boolean>;
  off(): void;
}

/**
 * Bounds on what Chrome itself keeps for this session's getResponseBody. A
 * body larger than the per-resource cap, or pushed out by newer ones, is
 * simply no longer available; nothing about it is kept on this side.
 */
export const NETWORK_BUFFER = {
  maxTotalBufferSize: 16 * 1024 * 1024,
  maxResourceBufferSize: 8 * 1024 * 1024,
} as const;

/** After a failed open, how long until a later tap may try again. */
const REOPEN_COOLDOWN_MS = 30_000;

interface TapState {
  ready: Promise<boolean>;
  /** When the last open attempt failed (0: none failed). */
  failedAt: number;
  session: CDPSession | null;
  listeners: Set<NetworkTapListener>;
}

const taps = new WeakMap<Page, TapState>();

interface CdpRequestWillBeSent {
  requestId: string;
  loaderId?: string;
  frameId?: string;
  type?: string;
  request: { url: string; method: string };
  redirectResponse?: { url: string; status: number; headers?: Record<string, unknown> };
}

interface CdpResponseReceived {
  requestId: string;
  response: { url: string; status: number; headers?: Record<string, unknown> };
}

function lowerHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = String(value);
  return out;
}

function dispatch<K extends keyof NetworkTapListener>(
  state: TapState,
  key: K,
  arg: Parameters<NonNullable<NetworkTapListener[K]>>[0],
): void {
  for (const listener of [...state.listeners]) {
    try {
      (listener[key] as ((a: typeof arg) => void) | undefined)?.(arg);
    } catch {
      // One watcher's failure must not starve the others.
    }
  }
}

async function openSession(page: Page, state: TapState): Promise<boolean> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return false;
  }
  if (typeof session?.on !== 'function') return false;
  let mainFrameId: string | undefined;
  session.on('Network.requestWillBeSent', (p: CdpRequestWillBeSent) => {
    if (p.redirectResponse) {
      // Playwright's shape: the redirected hop gets its response and finishes,
      // and the next hop is a request of its own (Chrome reuses the id).
      dispatch(state, 'onResponse', {
        requestId: p.requestId,
        url: p.redirectResponse.url,
        status: p.redirectResponse.status,
        headers: lowerHeaders(p.redirectResponse.headers),
      });
      dispatch(state, 'onFinished', p.requestId);
    }
    const resourceType = (p.type ?? 'Other').toLowerCase();
    dispatch(state, 'onRequest', {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      resourceType,
      navigation: resourceType === 'document' && p.requestId === p.loaderId,
      mainFrame: mainFrameId !== undefined && p.frameId === mainFrameId,
    });
  });
  session.on('Network.responseReceived', (p: CdpResponseReceived) => {
    dispatch(state, 'onResponse', {
      requestId: p.requestId,
      url: p.response.url,
      status: p.response.status,
      headers: lowerHeaders(p.response.headers),
    });
  });
  session.on('Network.loadingFinished', (p: { requestId: string }) => dispatch(state, 'onFinished', p.requestId));
  session.on('Network.loadingFailed', (p: { requestId: string }) => dispatch(state, 'onFailed', p.requestId));
  try {
    // Sent together: Chrome answers in order, and every round trip before
    // Network.enable is a window in which the page's requests go unseen.
    const [tree] = (await Promise.all([
      session.send('Page.getFrameTree'),
      session.send('Network.enable', { ...NETWORK_BUFFER }),
    ])) as [{ frameTree?: { frame?: { id?: string } } }, unknown];
    mainFrameId = tree.frameTree?.frame?.id;
  } catch {
    await session.detach().catch(() => undefined);
    return false;
  }
  if (taps.get(page) !== state) {
    // The page closed while the session was opening.
    await session.detach().catch(() => undefined);
    return false;
  }
  state.session = session;
  return true;
}

function startOpen(page: Page, state: TapState): void {
  state.failedAt = 0;
  state.ready = openSession(page, state).then((ok) => {
    if (!ok && taps.get(page) === state) state.failedAt = Date.now();
    return ok;
  });
}

/**
 * Watch a page's network traffic. The first tap on a page opens its session;
 * later ones share it. The session ends when the page closes, never earlier: a
 * detaching session resets page-wide emulation (see PlaywrightEngine's
 * reassertUserAgentEmulation), so it is not opened and closed per call.
 */
export function tapPageNetwork(page: Page, listener: NetworkTapListener): NetworkTap {
  let state = taps.get(page);
  if (!state) {
    const created: TapState = { ready: Promise.resolve(false), failedAt: 0, session: null, listeners: new Set() };
    taps.set(page, created);
    startOpen(page, created);
    const onClose = () => {
      page.off('close', onClose);
      if (taps.get(page) === created) taps.delete(page);
      created.listeners.clear();
      const session = created.session;
      created.session = null;
      void session?.detach().catch(() => undefined);
    };
    page.on('close', onClose);
    state = created;
  } else if (state.failedAt !== 0 && Date.now() - state.failedAt >= REOPEN_COOLDOWN_MS) {
    // A session that could not open (a transient relay error, a page mid-swap)
    // is tried again, at most once per cooldown; the listeners stay.
    startOpen(page, state);
  }
  const own = state;
  own.listeners.add(listener);
  return { ready: own.ready, off: () => own.listeners.delete(listener) };
}

/**
 * Wait (at most `maxMs`) until the page's tap is listening. A caller about to
 * drive the page awaits this, so the first navigation's requests are seen.
 */
export async function networkTapReady(page: Page, maxMs: number): Promise<boolean> {
  const state = taps.get(page);
  if (!state) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    state.ready,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), maxMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Why a body could not be returned. */
export type BodyUnavailable = 'no-session' | 'gone';

/**
 * Ask Chrome for one response body, now. 'gone' covers everything Chrome no
 * longer holds: pushed out of the NETWORK_BUFFER, over its per-resource cap,
 * or dropped when the page navigated away.
 */
export async function fetchResponseBody(
  page: Page,
  requestId: string,
): Promise<{ body: string } | { unavailable: BodyUnavailable }> {
  const state = taps.get(page);
  if (!state || !(await state.ready) || !state.session) return { unavailable: 'no-session' };
  try {
    const result = (await state.session.send('Network.getResponseBody', { requestId })) as {
      body: string;
      base64Encoded: boolean;
    };
    return { body: result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body };
  } catch {
    return { unavailable: 'gone' };
  }
}
