// ─── The phone's live browser stream (GET …/browser/stream, SSE)
//
// One shared screencast per tab, driven by main (the desktop). The daemon
// holds the subscribers: it asks main to start the tab's screencast for the
// first one and to stop it when the last one leaves, takes main's pushes
// (`daemon.phone.browserStream`), checks each one, and writes it to every
// subscriber of that tab:
//
//  - `hello` first, then the tab's latest frame;
//  - latest frame first: a frame is written only once the subscriber's
//    previous write has gone out and its own `maxFps` interval has passed;
//    a newer frame replaces one still waiting;
//  - `url` events at most ten a second, the last one always written;
//  - `: keepalive` every 15 s. A keepalive still unwritten at the next tick
//    closes the stream, as does an authorization that no longer holds;
//  - `end browser-stream-expired` after 30 minutes.
//
// docs/phone-client-contract.md "Live browser stream" is the client contract.

import { randomUUID } from 'node:crypto';
import { PHONE_BROWSER_ERROR_STATUS, isPhoneBrowserErrorCode } from '../../shared/phoneBrowserPreview';

export const BROWSER_STREAM_MAX_SUBSCRIBERS_PER_TAB = 4;
export const BROWSER_STREAM_MAX_PER_PRINCIPAL_PER_TAB = 2;
/** Tabs one desktop streams at once. */
export const BROWSER_STREAM_MAX_TABS = 4;
export const BROWSER_STREAM_KEEPALIVE_MS = 15_000;
export const BROWSER_STREAM_LIFETIME_MS = 30 * 60_000;
/** Nothing from main for this long (it pings every 15 s): its screencast is gone. */
export const BROWSER_STREAM_SILENT_MS = 45_000;
/** `url` events are written at most this often per subscriber. */
export const BROWSER_STREAM_URL_INTERVAL_MS = 100;
/** Base64 image data per frame. */
export const BROWSER_STREAM_FRAME_DATA_LIMIT = 700 * 1024;
export const BROWSER_STREAM_URL_LIMIT = 4096;
/** The response queue a stream may build up (StreamResponseLimits). */
export const BROWSER_STREAM_QUEUE_BYTES = 2 * 1024 * 1024;

const RANGES = {
  maxWidth: { min: 320, max: 1920, fallback: 1280 },
  maxHeight: { min: 320, max: 1920, fallback: 1280 },
  quality: { min: 30, max: 85, fallback: 60 },
  maxFps: { min: 1, max: 15, fallback: 10 },
} as const;

export interface BrowserStreamParams { maxWidth: number; maxHeight: number; quality: number; maxFps: number }

/**
 * The query, clamped. A value that is not a whole number, or a `viewport`
 * other than `mobile`, is null (400).
 */
export function parseBrowserStreamQuery(query: URLSearchParams): (BrowserStreamParams & { mobile: boolean }) | null {
  const out = {} as BrowserStreamParams;
  for (const name of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const raw = query.get(name);
    const range = RANGES[name];
    if (raw === null) { out[name] = range.fallback; continue; }
    if (!/^\d{1,6}$/.test(raw)) return null;
    out[name] = Math.min(range.max, Math.max(range.min, Number(raw)));
  }
  const viewport = query.get('viewport');
  if (viewport !== null && viewport !== 'mobile') return null;
  return { ...out, mobile: viewport === 'mobile' };
}

export type BrowserStreamEndCode = 'browser-tab-gone' | 'browser-backend-unavailable' | 'browser-preview-unavailable' | 'browser-stream-expired';
const END_CODES: ReadonlySet<string> = new Set(['browser-tab-gone', 'browser-backend-unavailable', 'browser-preview-unavailable', 'browser-stream-expired']);

/** What a subscriber writes to: an http.ServerResponse in production. */
export interface BrowserStreamSink {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  destroy(): void;
  readonly writableLength: number;
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
}

/** The desktop, as the stream needs it (DesktopPhoneBridge). */
export interface BrowserStreamDesktop {
  readonly ownerId: string | null;
  request(command: 'browser.streamStart' | 'browser.streamUpdate' | 'browser.streamStop', payload: Record<string, unknown>): Promise<unknown>;
  onOwnerLost(listener: () => void): () => void;
}

/** Who opens a stream: `principalKey` is `operator` or the device id. */
export interface BrowserStreamWho { principalKey: string; operator: boolean; deviceId?: string }

export type BrowserStreamRefusal = { status: number; error: string; retryAfter?: number };

interface Shared { backend: 'builtin' | 'chrome'; maxWidth: number; maxHeight: number; quality: number }

interface Tab {
  key: string;
  workspaceId: string;
  surfaceId: string;
  streamId: string;
  owner: string | null;
  desktop: BrowserStreamDesktop;
  subs: Set<Subscriber>;
  starting: Promise<Shared | BrowserStreamRefusal> | null;
  shared: Shared | null;
  /** The maxFps main was last asked for. */
  sentMaxFps: number;
  /** The latest frame's JSON without its `seq`, for a late subscriber. */
  latest: string | null;
  /** The latest url event's JSON when it came after that frame, for a late subscriber. */
  urlAfterLatest: string | null;
  /** When main last pushed for it, ping included. */
  lastPushAt: number;
  hidden: boolean;
  gone: boolean;
  /** Why main or the owner ended it, for a subscriber still starting. */
  endCode: BrowserStreamEndCode | null;
}

type Item = { kind: 'frame' | 'url' | 'state'; body: string };

interface Subscriber {
  tab: Tab;
  who: BrowserStreamWho;
  maxFps: number;
  sink: BrowserStreamSink | null;
  authorize: () => boolean;
  seq: number;
  lastFrameAt: number;
  lastUrlAt: number;
  queue: Item[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  tick: ReturnType<typeof setInterval> | null;
  expiry: ReturnType<typeof setTimeout> | null;
  keepalivePending: boolean;
  closed: boolean;
}

/** A reserved place on a tab's stream: start it, then open it or cancel it. */
export interface BrowserStreamReservation {
  /** Starts the tab's screencast, or joins the one starting or running. */
  start(): Promise<Shared | BrowserStreamRefusal>;
  /**
   * Opens the stream: `begin` writes the 200 head, then hello, the latest
   * frame and live events follow. The refusal instead, with nothing written,
   * when the tab's stream ended while it started.
   */
  open(sink: BrowserStreamSink, authorize: () => boolean, begin: () => void): BrowserStreamRefusal | null;
  cancel(): void;
}

function isRefusal(value: Shared | BrowserStreamRefusal): value is BrowserStreamRefusal {
  return 'status' in value;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function dimension(value: unknown): value is number {
  return finite(value) && value > 0 && value <= 32768;
}

/** A page URL main may stream: http(s), no credentials, at most 4096 characters. */
export function streamPageURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > BROWSER_STREAM_URL_LIMIT) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return value;
  } catch { return null; }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A pushed frame as the phone gets it, without `seq`; null when any field fails. */
function frameBody(push: Record<string, unknown>): string | null {
  const { data, capturedAt, imageWidth, imageHeight } = push;
  if (typeof data !== 'string' || !data || data.length > BROWSER_STREAM_FRAME_DATA_LIMIT || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  if (!finite(capturedAt) || !dimension(imageWidth) || !dimension(imageHeight)) return null;
  const body: Record<string, unknown> = { data, mimeType: 'image/jpeg', capturedAt, imageWidth, imageHeight };
  if (push.pageURL !== undefined) {
    const pageURL = streamPageURL(push.pageURL);
    if (!pageURL) return null;
    body.pageURL = pageURL;
    const g = push.geometry as Record<string, unknown> | undefined;
    if (g !== undefined) {
      if (!g || typeof g !== 'object' || !dimension(g.width) || !dimension(g.height) || !finite(g.scrollX) || !finite(g.scrollY) ||
          (g.scale !== undefined && !(finite(g.scale) && g.scale > 0 && g.scale <= 100))) return null;
      body.geometry = { width: g.width, height: g.height, scrollX: g.scrollX, scrollY: g.scrollY, ...(g.scale !== undefined ? { scale: g.scale } : {}) };
    }
  }
  return JSON.stringify(body);
}

function sse(event: string, body: string): string {
  return `event: ${event}\ndata: ${body}\n\n`;
}

export class BrowserStreamRegistry {
  private readonly tabs = new Map<string, Tab>();
  private readonly byStream = new Map<string, Tab>();
  private readonly watched = new WeakSet<BrowserStreamDesktop>();

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  /** Live subscribers, reserved ones included (tests, diagnostics). */
  get size(): number {
    let n = 0;
    for (const tab of this.tabs.values()) n += tab.subs.size;
    return n;
  }

  /**
   * A place on the tab's stream, or the refusal: at most four subscribers per
   * tab, two per device per tab, and four tabs per desktop.
   */
  reserve(desktop: BrowserStreamDesktop, workspaceId: string, surfaceId: string, who: BrowserStreamWho, params: BrowserStreamParams): BrowserStreamReservation | BrowserStreamRefusal {
    const key = `${workspaceId}\n${surfaceId}`;
    let tab = this.tabs.get(key);
    if (tab && tab.desktop !== desktop) tab = undefined;
    const busy: BrowserStreamRefusal = { status: 429, error: 'too-many-streams', retryAfter: 1 };
    if (tab) {
      if (tab.subs.size >= BROWSER_STREAM_MAX_SUBSCRIBERS_PER_TAB) return busy;
      if (!who.operator && [...tab.subs].filter((s) => s.who.principalKey === who.principalKey).length >= BROWSER_STREAM_MAX_PER_PRINCIPAL_PER_TAB) return busy;
    } else {
      if (this.tabs.size >= BROWSER_STREAM_MAX_TABS) return busy;
      this.watch(desktop);
      tab = {
        key, workspaceId, surfaceId, streamId: randomUUID(), owner: desktop.ownerId, desktop, subs: new Set(),
        starting: null, shared: null, sentMaxFps: params.maxFps, latest: null, urlAfterLatest: null, lastPushAt: 0, hidden: false, gone: false, endCode: null,
      };
      this.tabs.set(key, tab);
      this.byStream.set(tab.streamId, tab);
    }
    const sub: Subscriber = {
      tab, who, maxFps: params.maxFps, sink: null, authorize: () => false, seq: 0, lastFrameAt: 0, lastUrlAt: 0,
      queue: [], flushTimer: null, tick: null, expiry: null, keepalivePending: false, closed: false,
    };
    tab.subs.add(sub);
    const owned = tab;
    return {
      start: () => this.start(owned, sub, params),
      open: (sink, authorize, begin) => this.open(sub, sink, authorize, begin),
      cancel: () => this.close(sub),
    };
  }

  /** One of main's pushes. `known:false` tells main to stop that screencast. */
  push(clientId: string, params: Record<string, unknown>): { ok: boolean; known: boolean } {
    const tab = typeof params.streamId === 'string' ? this.byStream.get(params.streamId) : undefined;
    if (!tab || tab.gone || tab.owner === null || tab.owner !== clientId || tab.desktop.ownerId !== clientId) return { ok: false, known: false };
    tab.lastPushAt = Date.now();
    switch (params.kind) {
      case 'ping':
        return { ok: true, known: true };
      case 'frame': {
        const body = frameBody(params);
        if (!body) return { ok: false, known: true };
        tab.latest = body;
        tab.urlAfterLatest = null;
        tab.hidden = false;
        this.fanOut(tab, { kind: 'frame', body });
        return { ok: true, known: true };
      }
      case 'state': {
        if (params.state !== 'hidden' && params.state !== 'live') return { ok: false, known: true };
        tab.hidden = params.state === 'hidden';
        this.fanOut(tab, { kind: 'state', body: JSON.stringify(tab.hidden ? { state: 'hidden', reason: 'browser-tab-hidden' } : { state: 'live' }) });
        return { ok: true, known: true };
      }
      case 'url': {
        if (params.pageURL !== undefined && !streamPageURL(params.pageURL)) return { ok: false, known: true };
        const body = JSON.stringify(params.pageURL !== undefined ? { pageURL: params.pageURL } : {});
        tab.urlAfterLatest = body;
        this.fanOut(tab, { kind: 'url', body });
        return { ok: true, known: true };
      }
      case 'end': {
        const code = typeof params.error === 'string' && END_CODES.has(params.error) ? params.error as BrowserStreamEndCode : 'browser-preview-unavailable';
        this.endTab(tab, code);
        return { ok: true, known: true };
      }
      default:
        return { ok: false, known: true };
    }
  }

  /** A device was revoked or lost its grant: its streams close, with no `end`. */
  closeDevice(deviceId: string): number {
    let closed = 0;
    for (const tab of [...this.tabs.values()]) {
      for (const sub of [...tab.subs]) {
        if (sub.who.deviceId !== deviceId) continue;
        this.close(sub);
        closed += 1;
      }
    }
    return closed;
  }

  /** The web server is stopping: every stream closes, and main stops each screencast. */
  stopAll(): void {
    for (const tab of [...this.tabs.values()]) {
      for (const sub of [...tab.subs]) this.close(sub);
    }
  }

  private watch(desktop: BrowserStreamDesktop): void {
    if (this.watched.has(desktop)) return;
    this.watched.add(desktop);
    desktop.onOwnerLost(() => {
      for (const tab of [...this.tabs.values()]) {
        if (tab.desktop === desktop) this.endTab(tab, 'browser-backend-unavailable');
      }
    });
  }

  private start(tab: Tab, sub: Subscriber, params: BrowserStreamParams): Promise<Shared | BrowserStreamRefusal> {
    if (tab.shared) {
      this.raiseFps(tab, params.maxFps);
      return Promise.resolve(tab.shared);
    }
    if (!tab.starting) {
      tab.starting = (async (): Promise<Shared | BrowserStreamRefusal> => {
        let reply: unknown;
        try {
          reply = await tab.desktop.request('browser.streamStart', {
            workspaceId: tab.workspaceId, surfaceId: tab.surfaceId, streamId: tab.streamId,
            maxWidth: params.maxWidth, maxHeight: params.maxHeight, quality: params.quality, maxFps: params.maxFps,
          });
        } catch {
          return { status: 503, error: 'browser-preview-unavailable' };
        }
        const r = reply as Record<string, unknown> | null;
        if (r && typeof r === 'object' && 'error' in r) {
          return isPhoneBrowserErrorCode(r.error) ? { status: PHONE_BROWSER_ERROR_STATUS[r.error], error: r.error } : { status: 503, error: 'browser-preview-unavailable' };
        }
        if (!r || (r.backend !== 'chrome' && r.backend !== 'builtin') || !dimension(r.maxWidth) || !dimension(r.maxHeight) || !finite(r.quality)) {
          return { status: 503, error: 'browser-preview-unavailable' };
        }
        return { backend: r.backend, maxWidth: r.maxWidth, maxHeight: r.maxHeight, quality: r.quality };
      })().then((outcome) => {
        tab.starting = null;
        if (isRefusal(outcome)) {
          this.drop(tab);
          return outcome;
        }
        tab.shared = outcome;
        tab.lastPushAt = Date.now();
        // Everyone left while it started: stop what was just started.
        if (tab.subs.size === 0 || this.tabs.get(tab.key) !== tab) this.stopTab(tab);
        return outcome;
      });
    }
    const starting = tab.starting;
    return starting.then((outcome) => {
      if (!isRefusal(outcome)) this.raiseFps(tab, sub.maxFps);
      return outcome;
    });
  }

  private raiseFps(tab: Tab, maxFps: number): void {
    if (!tab.shared || maxFps <= tab.sentMaxFps || tab.gone) return;
    tab.sentMaxFps = maxFps;
    tab.desktop.request('browser.streamUpdate', { workspaceId: tab.workspaceId, surfaceId: tab.surfaceId, streamId: tab.streamId, maxFps })
      .catch(() => undefined);
  }

  private open(sub: Subscriber, sink: BrowserStreamSink, authorize: () => boolean, begin: () => void): BrowserStreamRefusal | null {
    const tab = sub.tab;
    if (sub.closed || !tab.shared || tab.gone) {
      this.close(sub);
      return tab.endCode === 'browser-tab-gone' ? { status: 404, error: 'browser-tab-gone' } : { status: 503, error: tab.endCode ?? 'browser-preview-unavailable' };
    }
    sub.sink = sink;
    sub.authorize = authorize;
    sink.once('close', () => this.close(sub));
    if (sink.destroyed) { this.close(sub); return null; }
    begin();
    const shared = tab.shared;
    this.write(sub, sse('hello', JSON.stringify({ v: 1, surfaceId: tab.surfaceId, backend: shared.backend, maxWidth: shared.maxWidth, maxHeight: shared.maxHeight, quality: shared.quality, maxFps: sub.maxFps })));
    if (tab.latest) sub.queue.push({ kind: 'frame', body: tab.latest });
    // A URL change with no repaint since: without it, the frame's URL is stale.
    if (tab.urlAfterLatest) sub.queue.push({ kind: 'url', body: tab.urlAfterLatest });
    if (tab.hidden) sub.queue.push({ kind: 'state', body: JSON.stringify({ state: 'hidden', reason: 'browser-tab-hidden' }) });
    sub.tick = setInterval(() => this.onTick(sub), BROWSER_STREAM_KEEPALIVE_MS);
    sub.tick.unref?.();
    sub.expiry = setTimeout(() => this.end(sub, 'browser-stream-expired'), BROWSER_STREAM_LIFETIME_MS);
    sub.expiry.unref?.();
    this.flush(sub);
    return null;
  }

  private onTick(sub: Subscriber): void {
    const sink = sub.sink;
    if (sub.closed || !sink) return;
    // The last keepalive is still queued behind what went before it: the
    // client stopped reading.
    if (sub.keepalivePending) {
      this.log('browser stream closed: client stopped reading');
      sink.destroy();
      this.close(sub);
      return;
    }
    // Main's end never came (lost, or main stalled): the screencast is gone.
    if (sub.tab.shared && Date.now() - sub.tab.lastPushAt >= BROWSER_STREAM_SILENT_MS) {
      this.endTab(sub.tab, 'browser-backend-unavailable');
      return;
    }
    let allowed = false;
    try { allowed = sub.authorize(); } catch { allowed = false; }
    // Like a revoke: the stream closes with no `end`.
    if (!allowed) { this.close(sub); return; }
    sub.keepalivePending = true;
    this.write(sub, ': keepalive\n\n', () => { sub.keepalivePending = false; });
  }

  private fanOut(tab: Tab, item: Item): void {
    for (const sub of tab.subs) {
      if (!sub.sink || sub.closed) continue;
      // One waiting item of each kind; a newer one replaces it at the back.
      const at = sub.queue.findIndex((queued) => queued.kind === item.kind);
      if (at >= 0) sub.queue.splice(at, 1);
      sub.queue.push(item);
      this.flush(sub);
    }
  }

  private flush(sub: Subscriber): void {
    const sink = sub.sink;
    if (sub.closed || !sink) return;
    if (sub.flushTimer) { clearTimeout(sub.flushTimer); sub.flushTimer = null; }
    while (sub.queue.length > 0) {
      // Whatever went before has not gone out yet: wait for its completion.
      if (sink.writableLength > 0 || sink.destroyed) return;
      const item = sub.queue[0];
      const now = Date.now();
      const due = item.kind === 'frame' ? sub.lastFrameAt + 1000 / sub.maxFps
        : item.kind === 'url' ? sub.lastUrlAt + BROWSER_STREAM_URL_INTERVAL_MS : now;
      if (due > now) {
        sub.flushTimer = setTimeout(() => { sub.flushTimer = null; this.flush(sub); }, due - now);
        sub.flushTimer.unref?.();
        return;
      }
      sub.queue.shift();
      if (item.kind === 'frame') {
        sub.lastFrameAt = now;
        sub.seq += 1;
        this.write(sub, sse('frame', `{"seq":${sub.seq},${item.body.slice(1)}`));
      } else {
        if (item.kind === 'url') sub.lastUrlAt = now;
        this.write(sub, sse(item.kind, item.body));
      }
    }
  }

  /** Every write's completion lets whatever waits behind it go. */
  private write(sub: Subscriber, chunk: string, done?: () => void): void {
    try {
      sub.sink?.write(chunk, () => { done?.(); this.flush(sub); });
    } catch {
      /* the response is gone: its close handler cleans up */
    }
  }

  /** `end` with its code, then the stream closes. */
  private end(sub: Subscriber, code: BrowserStreamEndCode): void {
    if (sub.closed) return;
    this.write(sub, sse('end', JSON.stringify({ error: code })));
    this.close(sub);
  }

  /** Main ended the tab's stream, or its owner left: no stop is sent. */
  private endTab(tab: Tab, code: BrowserStreamEndCode): void {
    tab.gone = true;
    tab.endCode = code;
    this.drop(tab);
    for (const sub of [...tab.subs]) {
      // A subscriber still starting hears the code from open().
      if (sub.sink) this.end(sub, code);
    }
  }

  private close(sub: Subscriber): void {
    if (sub.closed) return;
    sub.closed = true;
    if (sub.flushTimer) clearTimeout(sub.flushTimer);
    if (sub.tick) clearInterval(sub.tick);
    if (sub.expiry) clearTimeout(sub.expiry);
    sub.queue = [];
    const sink = sub.sink;
    if (sink && !sink.destroyed) {
      try { sink.end(); } catch { /* already gone */ }
    }
    const tab = sub.tab;
    tab.subs.delete(sub);
    if (tab.subs.size > 0 || tab.gone) return;
    this.drop(tab);
    // Still starting: the start's own completion stops it.
    if (tab.shared && !tab.starting) this.stopTab(tab);
  }

  private drop(tab: Tab): void {
    if (this.tabs.get(tab.key) === tab) this.tabs.delete(tab.key);
    if (this.byStream.get(tab.streamId) === tab) this.byStream.delete(tab.streamId);
  }

  private stopTab(tab: Tab): void {
    if (tab.gone) return;
    tab.gone = true;
    this.drop(tab);
    tab.desktop.request('browser.streamStop', { workspaceId: tab.workspaceId, surfaceId: tab.surfaceId, streamId: tab.streamId })
      .catch(() => undefined);
  }
}
