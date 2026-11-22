import type { CDPSession, Frame, Page } from 'playwright-core';

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
// Coverage: the page's own target, plus one session per cross-site iframe that
// runs in its own process (an OOPIF), up to MAX_FRAME_SESSIONS per page.
// Requests from workers are not seen: Playwright opens no CDP session for one.
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
  /**
   * Loaded in full, or redirected (the next hop starts as a new request with
   * the same id). `encodedDataLength` is the bytes received, when Chrome says.
   */
  onFinished?: (requestId: string, encodedDataLength?: number) => void;
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
/** OOPIF sessions per page; a page full of cross-site ad frames stops here. */
export const MAX_FRAME_SESSIONS = 16;
/** Request ids remembered with the session that saw them, for getResponseBody. */
const MAX_REQUEST_SESSIONS = 2_000;

interface TapState {
  ready: Promise<boolean>;
  /** When the last open attempt failed (0: none failed). */
  failedAt: number;
  session: CDPSession | null;
  listeners: Set<NetworkTapListener>;
  /** One session per out-of-process iframe (Playwright opens one only for those). */
  frames: Map<Frame, CDPSession>;
  /** Frames whose session is being opened, so two navigations do not open two. */
  opening: Set<Frame>;
  /** Frames that navigated again while being opened: checked once more after. */
  retap: Set<Frame>;
  /** Each frame session's requests that have started and not settled. */
  inflight: Map<CDPSession, Set<string>>;
  /** Which frame session saw a request; absent means the page's own session. */
  sessionOf: Map<string, CDPSession>;
  capLogged: boolean;
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
  ...args: Parameters<NonNullable<NetworkTapListener[K]>>
): void {
  for (const listener of [...state.listeners]) {
    try {
      (listener[key] as ((...a: typeof args) => void) | undefined)?.(...args);
    } catch {
      // One watcher's failure must not starve the others.
    }
  }
}

/** Feed one session's Network events to the page's watchers. */
function listen(
  state: TapState,
  session: CDPSession,
  mainFrameOf: () => string | undefined,
  frameSession = false,
): void {
  const open = new Set<string>();
  if (frameSession) state.inflight.set(session, open);
  const settle = (requestId: string) => open.delete(requestId);
  session.on('Network.requestWillBeSent', (p: CdpRequestWillBeSent) => {
    if (frameSession) {
      rememberSession(state, p.requestId, session);
      open.add(p.requestId);
    }
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
      mainFrame: mainFrameOf() !== undefined && p.frameId === mainFrameOf(),
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
  session.on('Network.loadingFinished', (p: { requestId: string; encodedDataLength?: number }) => {
    settle(p.requestId);
    dispatch(state, 'onFinished', p.requestId, p.encodedDataLength);
  });
  session.on('Network.loadingFailed', (p: { requestId: string }) => {
    settle(p.requestId);
    dispatch(state, 'onFailed', p.requestId);
  });
}

/**
 * Let a frame session go: its unsettled requests will never finish here, so
 * they fail now (a settle wait or pending count must not wait on them), and
 * the request ids it saw are forgotten.
 */
function dropFrameSession(state: TapState, session: CDPSession): void {
  const open = state.inflight.get(session);
  state.inflight.delete(session);
  for (const requestId of open ?? []) dispatch(state, 'onFailed', requestId);
  for (const [requestId, owner] of state.sessionOf) if (owner === session) state.sessionOf.delete(requestId);
  void session.detach().catch(() => undefined);
}

function rememberSession(state: TapState, requestId: string, session: CDPSession): void {
  state.sessionOf.delete(requestId);
  state.sessionOf.set(requestId, session);
  if (state.sessionOf.size > MAX_REQUEST_SESSIONS) state.sessionOf.delete(state.sessionOf.keys().next().value as string);
}

/**
 * Open (or check) the Network session of one iframe. Playwright's
 * newCDPSession(frame) succeeds only for an out-of-process frame, so an
 * in-process one simply fails here and is already covered by its parent's.
 * A frame that navigated may have moved to a new process, which ends its old
 * session: a session that no longer answers is replaced.
 */
async function tapFrame(page: Page, state: TapState, frame: Frame): Promise<void> {
  if (taps.get(page) !== state) return;
  if (state.opening.has(frame)) {
    // It navigated again mid-open (about:blank, then cross-site): look again after.
    state.retap.add(frame);
    return;
  }
  const existing = state.frames.get(frame);
  if (existing) {
    const alive = await existing.send('Network.enable', { ...NETWORK_BUFFER }).then(() => true, () => false);
    if (alive || state.frames.get(frame) !== existing) return;
    state.frames.delete(frame);
    dropFrameSession(state, existing);
  }
  if (frameCapReached(state)) return;
  state.opening.add(frame);
  try {
    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(frame);
    } catch {
      return; // in-process frame, or gone
    }
    // Checked again only now: an in-process frame, which fails above, must
    // not take a cross-site frame's place while its attempt is pending.
    if (frameCapReached(state)) {
      await session.detach().catch(() => undefined);
      return;
    }
    // Taken now, before the await, so concurrent opens cannot overshoot the cap.
    state.frames.set(frame, session);
    listen(state, session, () => undefined, true);
    const enabled = await session.send('Network.enable', { ...NETWORK_BUFFER }).then(() => true, () => false);
    if (!enabled || taps.get(page) !== state || frame.isDetached()) {
      if (state.frames.get(frame) === session) state.frames.delete(frame);
      dropFrameSession(state, session);
    }
  } finally {
    state.opening.delete(frame);
    if (state.retap.delete(frame) && !frame.isDetached()) void tapFrame(page, state, frame);
  }
}

function frameCapReached(state: TapState): boolean {
  if (state.frames.size < MAX_FRAME_SESSIONS) return false;
  if (!state.capLogged) {
    state.capLogged = true;
    console.error(`[wmux-mcp] network capture: ${MAX_FRAME_SESSIONS} cross-site iframe sessions on one page; later iframes are not captured`);
  }
  return true;
}

function untapFrame(state: TapState, frame: Frame): void {
  const session = state.frames.get(frame);
  if (!session) return;
  state.frames.delete(frame);
  dropFrameSession(state, session);
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
  listen(state, session, () => mainFrameId);
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
  if (typeof page.frames === 'function') {
    for (const frame of page.frames()) if (frame !== page.mainFrame()) void tapFrame(page, state, frame);
  }
  return true;
}

/**
 * A session that could not open (a transient relay error, a page mid-swap) is
 * tried again, at most once per cooldown; the listeners stay.
 */
function reopenIfDue(page: Page, state: TapState): void {
  if (state.failedAt !== 0 && Date.now() - state.failedAt >= REOPEN_COOLDOWN_MS) startOpen(page, state);
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
    const created: TapState = {
      ready: Promise.resolve(false),
      failedAt: 0,
      session: null,
      listeners: new Set(),
      frames: new Map(),
      opening: new Set(),
      retap: new Set(),
      inflight: new Map(),
      sessionOf: new Map(),
      capLogged: false,
    };
    taps.set(page, created);
    startOpen(page, created);
    const isChild = (frame: Frame) => {
      try {
        return frame !== page.mainFrame();
      } catch {
        return false;
      }
    };
    // A cross-site iframe gets its own process at navigation, so that is when
    // its session can be opened (or found dead and replaced).
    const onFrameNavigated = (frame: Frame) => {
      if (isChild(frame) && created.session) void tapFrame(page, created, frame);
    };
    const onFrameDetached = (frame: Frame) => untapFrame(created, frame);
    const onClose = () => {
      page.off('close', onClose);
      page.off('framenavigated', onFrameNavigated);
      page.off('framedetached', onFrameDetached);
      if (taps.get(page) === created) taps.delete(page);
      created.listeners.clear();
      created.sessionOf.clear();
      for (const frame of [...created.frames.keys()]) untapFrame(created, frame);
      const session = created.session;
      created.session = null;
      void session?.detach().catch(() => undefined);
    };
    page.on('close', onClose);
    page.on('framenavigated', onFrameNavigated);
    page.on('framedetached', onFrameDetached);
    state = created;
  } else {
    reopenIfDue(page, state);
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
  reopenIfDue(page, state);
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
  const session = state.sessionOf.get(requestId) ?? state.session;
  try {
    const result = (await session.send('Network.getResponseBody', { requestId })) as {
      body: string;
      base64Encoded: boolean;
    };
    return { body: result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body };
  } catch {
    return { unavailable: 'gone' };
  }
}
