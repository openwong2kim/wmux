// ─── The phone's live browser stream, main's side (dedicated-profile Chrome)
//
// The daemon asks for a tab's screencast (`browser.streamStart`) when the
// first phone subscribes and stops it (`browser.streamStop`) when the last
// one leaves (src/daemon/web/browserStream.ts). Main runs one screencast per
// tab on a CDP session of its own (ChromeLauncher.streamSession) and pushes
// what it sees to the daemon over `daemon.phone.browserStream`:
//
//  - `frame`: the JPEG Chrome painted, with the page URL and the geometry the
//    phone maps its input with, both left out mid-navigation and the geometry
//    left out under browser zoom or a top offset;
//  - `url`: each committed URL change, ten a second at most;
//  - `state`: hidden when Chrome reports the tab not visible, or a probe
//    reads it hidden, after five quiet seconds; live when frames come back;
//  - `end`: the tab is gone, or its page is not an http(s) one;
//  - `ping`: every 15 s, so a stream the daemon forgot stops here too.
//
// One push per tab is in flight at a time, and Chrome's frame is acked only
// once the daemon has answered it, so a slow pipe slows Chrome down instead
// of queueing. Every push stays inside the control pipe's line limit.

import type { ChromeStreamSession } from '../browser-session/ChromeLauncher';
import { ChromePageSessionError } from '../browser-session/ChromeLauncher';
import { readImageSize } from '../../mcp/playwright/imageSize';
import { PhoneBrowserError } from '../../shared/phoneBrowserPreview';
import { PHONE_CHROME_CAPTURE_MS } from './PhoneBrowserChrome';

const STREAM_ENV = 'WMUX_PHONE_BROWSER_STREAM';

/** Whether this desktop offers the phone browser stream (off unless `WMUX_PHONE_BROWSER_STREAM=1`). */
export function phoneBrowserStreamEnabled(): boolean {
  return process.env[STREAM_ENV] === '1';
}

/** Frames main pushes per second, all tabs together. */
export const STREAM_FRAMES_PER_SECOND = 60;
/** Frame bytes main pushes per second, all tabs together. */
export const STREAM_BYTES_PER_SECOND = 8 * 1024 * 1024;
/** One serialized push: inside the daemon pipe's 1 MiB line limit. */
export const STREAM_LINE_LIMIT = 900 * 1024;
export const STREAM_DATA_LIMIT = 700 * 1024;
const URL_LIMIT = 4096;
const MAX_TABS = 4;
/** URLs remembered for the current document (input's `expectedURL`). */
export const STREAM_DOC_URLS = 64;
const FIRST_FRAME_MS = 1_000;
const ZOOM_POLL_MS = 2_000;
const QUIET_MS = 5_000;
const PING_MS = 15_000;
const URL_INTERVAL_MS = 100;
const TICK_MS = 500;
const PUSH_TIMEOUT_MS = 3_000;
/** How long a page swap is given to bind the tab's new page before re-attaching. */
const SWAP_SETTLE_MS = 500;
const MIN_SIDE = 320;
const MIN_QUALITY = 30;
/** Fixed probe; nothing in it comes from the phone. */
const VISIBILITY_PROBE = 'document.visibilityState';

/** The geometry a frame carries, in CSS pixels; `scale` only when the page is pinch-zoomed. */
export interface PhoneStreamGeometry { width: number; height: number; scrollX: number; scrollY: number; scale?: number }

/** A streamed tab as input reads it (PhoneBrowser.ts). */
export interface PhoneStreamTabView {
  /** The last committed page URL (credential-free http(s)); null until the stream has read it. */
  readonly url: string | null;
  /** URLs this document has had since its last cross-document commit, the live one included. */
  readonly docUrls: ReadonlySet<string>;
  /** The latest frame's geometry, forwarded or not; null while frames carry none. */
  readonly geometry: PhoneStreamGeometry | null;
}

/** Main's dedicated Chrome tabs, as the stream needs them (PhoneBrowserChrome deps). */
export interface PhoneStreamChromeDeps {
  tabs(workspaceId: string): Promise<Array<{ surfaceId: string; url: string }>>;
  streamSession?(surfaceId: string, workspaceId: string): Promise<ChromeStreamSession>;
  /** Whether the tab's record still names this workspace. */
  owns?(surfaceId: string, workspaceId: string): boolean;
}

export interface PhoneBrowserStreamDeps {
  /** `daemon.phone.browserStream`; rejects with the daemon's refusal. */
  push(params: Record<string, unknown>): Promise<unknown>;
  backend(): string;
  chrome?: PhoneStreamChromeDeps;
  /** Test seam for PHONE_CHROME_CAPTURE_MS. */
  captureMs?: number;
}

export interface PhoneBrowserStreams {
  /** `browser.streamStart` / `browser.streamUpdate` / `browser.streamStop`. */
  handle(command: string, payload: Record<string, unknown>): Promise<unknown>;
  /** The tab's stream, or null when none runs on it. */
  tab(surfaceId: string, workspaceId: string): PhoneStreamTabView | null;
  /** Stops every screencast here (the daemon went away). */
  stopAll(): void;
}

/** The credential-stripped http(s) URL, or null. */
function httpURL(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = ''; url.password = '';
    return url.href;
  } catch { return null; }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Main's push budget across tabs: frames and bytes per second. */
class Budget {
  private start = 0;
  private frames = 0;
  private bytes = 0;
  /** Charges one frame of `bytes`; false (nothing charged) past the budget. */
  take(bytes: number, now: number): boolean {
    if (now - this.start >= 1000) { this.start = now; this.frames = 0; this.bytes = 0; }
    if (this.frames + 1 > STREAM_FRAMES_PER_SECOND || this.bytes + bytes > STREAM_BYTES_PER_SECOND) return false;
    this.frames += 1;
    this.bytes += bytes;
    return true;
  }
  /** Milliseconds until the budget opens again. */
  wait(now: number): number { return Math.max(1, this.start + 1000 - now); }
}

type Outgoing = { kind: 'frame' | 'url' | 'state'; params: Record<string, unknown>; ack?: number; bytes: number };

interface ScreencastFrame { data?: unknown; metadata?: Record<string, unknown>; sessionId?: unknown }

class TabStream implements PhoneStreamTabView {
  url: string | null = null;
  docUrls = new Set<string>();
  geometry: PhoneStreamGeometry | null = null;
  private session: ChromeStreamSession | null = null;
  private stopped = false;
  private mainFrameId: string | null = null;
  private navigating = false;
  private zoom = 1;
  private hidden = false;
  private invisibleSince: number | null = null;
  private lastFrameAt = 0;
  private lastZoomAt = 0;
  private lastProbeAt = 0;
  private lastPingAt = 0;
  private lastFramePushAt = 0;
  private lastUrlPushAt = 0;
  private inFlight = false;
  private outbox: Outgoing[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private firstFrame: ReturnType<typeof setTimeout> | null = null;
  private reattached = false;
  readonly size: { maxWidth: number; maxHeight: number; quality: number };

  constructor(
    readonly streamId: string,
    readonly workspaceId: string,
    readonly surfaceId: string,
    params: { maxWidth: number; maxHeight: number; quality: number },
    public maxFps: number,
    private readonly deps: PhoneBrowserStreamDeps,
    private readonly chrome: PhoneStreamChromeDeps & Required<Pick<PhoneStreamChromeDeps, 'streamSession'>>,
    private readonly budget: Budget,
    private readonly onStopped: (stream: TabStream) => void,
  ) {
    this.size = { ...params };
  }

  async start(): Promise<void> {
    await this.attach();
    const now = Date.now();
    this.lastPingAt = now;
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    this.tick.unref?.();
  }

  private async attach(): Promise<void> {
    const session = await this.chrome.streamSession(this.surfaceId, this.workspaceId);
    if (this.stopped) { void session.detach(); return; }
    this.session = session;
    session.on('Page.screencastFrame', (p) => this.onFrame(p as ScreencastFrame));
    session.on('Page.screencastVisibilityChanged', (p) => {
      this.invisibleSince = p.visible === false ? (this.invisibleSince ?? Date.now()) : null;
    });
    session.on('Page.frameStartedNavigating', (p) => {
      const type = p.navigationType;
      if (p.frameId === this.mainFrameId && type !== 'sameDocument' && type !== 'historySameDocument') this.startNavigating();
    });
    session.on('Page.frameStartedLoading', (p) => { if (p.frameId === this.mainFrameId) this.startNavigating(); });
    session.on('Page.frameStoppedLoading', (p) => { if (p.frameId === this.mainFrameId) this.navigating = false; });
    session.on('Page.frameNavigated', (p) => this.onNavigated(p.frame as Record<string, unknown> | undefined));
    session.on('Page.navigatedWithinDocument', (p) => {
      if (p.frameId === this.mainFrameId) this.commit(p.url, false);
    });
    session.onClosed(() => this.onClosed(session));
    await session.send('Page.enable');
    const tree = await session.send('Page.getFrameTree') as { frameTree?: { frame?: Record<string, unknown> } } | null;
    const frame = tree?.frameTree?.frame;
    if (!frame || typeof frame.id !== 'string') throw new Error('Browser operation failed');
    this.mainFrameId = frame.id;
    const url = httpURL(`${String(frame.url ?? '')}${typeof frame.urlFragment === 'string' ? frame.urlFragment : ''}`);
    if (!url) throw new Error('Only HTTP browser previews are supported');
    this.url = url;
    this.docUrls = new Set(url.length <= URL_LIMIT ? [url] : []);
    await this.readZoom();
    await this.startScreencast();
    this.armFirstFrame();
  }

  private async startScreencast(): Promise<unknown> {
    if (!this.session) throw new ChromePageSessionError('gone', 'stream session ended');
    return this.session.send('Page.startScreencast', {
      format: 'jpeg', quality: this.size.quality, maxWidth: this.size.maxWidth, maxHeight: this.size.maxHeight, everyNthFrame: 1,
    });
  }

  private armFirstFrame(): void {
    if (this.firstFrame) clearTimeout(this.firstFrame);
    const armedAt = Date.now();
    this.firstFrame = setTimeout(() => { this.firstFrame = null; void this.fallbackFrame(armedAt); }, FIRST_FRAME_MS);
    this.firstFrame.unref?.();
  }

  private startNavigating(): void {
    this.navigating = true;
  }

  private onNavigated(frame: Record<string, unknown> | undefined): void {
    if (!frame || frame.parentId !== undefined || typeof frame.id !== 'string') return;
    this.mainFrameId = frame.id;
    this.navigating = false;
    this.commit(`${String(frame.url ?? '')}${typeof frame.urlFragment === 'string' ? frame.urlFragment : ''}`, true);
    void this.readZoom();
  }

  /** A committed main-frame URL: same-document, or a new document. */
  private commit(raw: unknown, newDocument: boolean): void {
    if (this.stopped) return;
    const url = httpURL(raw);
    // Today's preview refuses a page that is not http(s); so does the stream.
    if (!url) { void this.end('browser-preview-unavailable'); return; }
    if (newDocument) this.docUrls = new Set();
    if (url.length <= URL_LIMIT) {
      // The oldest goes first past the cap; the live URL is always the newest.
      this.docUrls.delete(url);
      this.docUrls.add(url);
      while (this.docUrls.size > STREAM_DOC_URLS) this.docUrls.delete(this.docUrls.values().next().value as string);
    }
    this.url = url;
    this.enqueue({ kind: 'url', params: { streamId: this.streamId, kind: 'url', ...(url.length <= URL_LIMIT ? { pageURL: url } : {}) }, bytes: 0 });
  }

  private onFrame(frame: ScreencastFrame): void {
    const ack = typeof frame.sessionId === 'number' ? frame.sessionId : undefined;
    if (this.stopped) { this.ack(ack); return; }
    const now = Date.now();
    this.lastFrameAt = now;
    this.invisibleSince = null;
    if (this.firstFrame) { clearTimeout(this.firstFrame); this.firstFrame = null; }
    this.geometry = this.geometryOf(frame.metadata);
    if (this.chrome.owns && !this.chrome.owns(this.surfaceId, this.workspaceId)) { this.ack(ack); void this.end('browser-tab-gone'); return; }
    if (typeof frame.data !== 'string' || !frame.data) { this.ack(ack); return; }
    if (this.hidden) this.goLive();
    this.offerFrame(frame.data, this.geometry, ack);
  }

  /** The frame's own geometry, or null when input could not land where the phone sees it. */
  private geometryOf(meta: Record<string, unknown> | undefined): PhoneStreamGeometry | null {
    if (!meta || this.navigating || this.zoom !== 1) return null;
    const { deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY, pageScaleFactor, offsetTop } = meta;
    if (!finite(deviceWidth) || !finite(deviceHeight) || deviceWidth <= 0 || deviceHeight <= 0 || !finite(scrollOffsetX) || !finite(scrollOffsetY)) return null;
    if (offsetTop !== undefined && offsetTop !== 0) return null;
    const scale = finite(pageScaleFactor) && pageScaleFactor > 0 ? pageScaleFactor : 1;
    return { width: deviceWidth, height: deviceHeight, scrollX: scrollOffsetX, scrollY: scrollOffsetY, ...(scale !== 1 ? { scale } : {}) };
  }

  /** Builds the frame push and queues it, or drops it (acked) when it would not fit. */
  private offerFrame(data: string, geometry: PhoneStreamGeometry | null, ack: number | undefined): void {
    const size = readImageSize(data);
    if (!size) { this.ack(ack); return; }
    const url = !this.navigating && this.url && this.url.length <= URL_LIMIT ? this.url : null;
    const params: Record<string, unknown> = {
      streamId: this.streamId, kind: 'frame', data, capturedAt: Date.now(), imageWidth: size.width, imageHeight: size.height,
      ...(url ? { pageURL: url, ...(geometry ? { geometry } : {}) } : {}),
    };
    const bytes = data.length > STREAM_DATA_LIMIT ? Infinity : JSON.stringify(params).length + 256;
    if (bytes > STREAM_LINE_LIMIT) {
      this.ack(ack);
      void this.shrink();
      return;
    }
    this.enqueue({ kind: 'frame', params, ack, bytes });
  }

  /** A frame too large for the pipe: the screencast restarts smaller. */
  private async shrink(): Promise<void> {
    const next = {
      maxWidth: Math.max(MIN_SIDE, Math.floor(this.size.maxWidth * 0.75)),
      maxHeight: Math.max(MIN_SIDE, Math.floor(this.size.maxHeight * 0.75)),
      quality: Math.max(MIN_QUALITY, this.size.quality - 15),
    };
    if (next.maxWidth === this.size.maxWidth && next.maxHeight === this.size.maxHeight && next.quality === this.size.quality) return;
    Object.assign(this.size, next);
    try {
      await this.session?.send('Page.stopScreencast');
      if (!this.stopped) await this.startScreencast();
    } catch { /* the session's own close ends the stream */ }
  }

  private goLive(): void {
    this.hidden = false;
    this.enqueue({ kind: 'state', params: { streamId: this.streamId, kind: 'state', state: 'live' }, bytes: 0 });
  }

  private goHidden(): void {
    if (this.hidden || this.stopped) return;
    this.hidden = true;
    this.enqueue({ kind: 'state', params: { streamId: this.streamId, kind: 'state', state: 'hidden' }, bytes: 0 });
  }

  /** One waiting push of each kind; a newer one replaces it at the back (its frame acked). */
  private enqueue(item: Outgoing): void {
    if (this.stopped) { this.ack(item.ack); return; }
    const at = this.outbox.findIndex((queued) => queued.kind === item.kind);
    if (at >= 0) this.ack(this.outbox.splice(at, 1)[0].ack);
    this.outbox.push(item);
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || this.stopped || this.outbox.length === 0) return;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const item = this.outbox[0];
    const now = Date.now();
    let wait = 0;
    if (item.kind === 'frame') {
      wait = this.lastFramePushAt + 1000 / this.maxFps - now;
      if (wait <= 0 && !this.budget.take(item.bytes, now)) wait = this.budget.wait(now);
    } else if (item.kind === 'url') {
      wait = this.lastUrlPushAt + URL_INTERVAL_MS - now;
    }
    if (wait > 0) {
      this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, wait);
      this.pumpTimer.unref?.();
      return;
    }
    this.outbox.shift();
    if (item.kind === 'frame') this.lastFramePushAt = now;
    if (item.kind === 'url') this.lastUrlPushAt = now;
    this.send(item.params, () => {
      // The daemon answered (or refused): only now may Chrome paint the next one.
      this.ack(item.ack);
    });
  }

  /** One push in flight; a refused push is a dropped frame, `known:false` stops here. */
  private send(params: Record<string, unknown>, done: () => void): void {
    this.inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('push timed out')), PUSH_TIMEOUT_MS);
      timer.unref?.();
    });
    Promise.race([this.deps.push(params), timeout]).then((reply) => {
      if ((reply as { known?: unknown } | null)?.known === false) this.stop();
    }, () => { /* rate limited, timed out or disconnected: dropped; the ping decides the rest */ }).finally(() => {
      clearTimeout(timer);
      this.inFlight = false;
      done();
      this.pump();
    });
  }

  private ack(id: number | undefined): void {
    if (id === undefined) return;
    void this.session?.send('Page.screencastFrameAck', { sessionId: id }).catch(() => undefined);
  }

  private onTick(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastPingAt >= PING_MS) {
      this.lastPingAt = now;
      // A ping waits its turn behind nothing: it does not carry a frame.
      void this.deps.push({ streamId: this.streamId, kind: 'ping' }).then((reply) => {
        if ((reply as { known?: unknown } | null)?.known === false) this.stop();
      }, () => undefined);
    }
    if (now - this.lastFrameAt < ZOOM_POLL_MS && now - this.lastZoomAt >= ZOOM_POLL_MS) void this.readZoom();
    if (this.hidden) return;
    // Chrome said the tab is not visible, and nothing was painted since.
    if (this.invisibleSince !== null && now - this.invisibleSince >= QUIET_MS && this.lastFrameAt <= this.invisibleSince) {
      this.goHidden();
      return;
    }
    // Five quiet seconds are only a reason to look: a still page sends nothing either.
    if (now - this.lastFrameAt >= QUIET_MS && now - this.lastProbeAt >= QUIET_MS && !this.firstFrame) {
      this.lastProbeAt = now;
      void this.probeHidden();
    }
  }

  private async probeHidden(): Promise<void> {
    try {
      const result = await this.session?.send('Runtime.evaluate', { expression: VISIBILITY_PROBE, returnByValue: true }) as { result?: { value?: unknown } } | undefined;
      if (result?.result?.value === 'hidden' && Date.now() - this.lastFrameAt >= QUIET_MS) this.goHidden();
    } catch { /* the session's close ends the stream */ }
  }

  private async readZoom(): Promise<void> {
    this.lastZoomAt = Date.now();
    try {
      const metrics = await this.session?.send('Page.getLayoutMetrics') as { cssVisualViewport?: { zoom?: unknown } } | undefined;
      const zoom = metrics?.cssVisualViewport?.zoom;
      this.zoom = zoom === undefined ? 1 : finite(zoom) && zoom > 0 ? zoom : NaN;
    } catch { /* kept as it was */ }
  }

  /**
   * Nothing painted in the first second (a still page sends no frame until it
   * repaints): one capture instead, within the capture budget. A tab that does
   * not produce even that is hidden.
   */
  private async fallbackFrame(armedAt: number): Promise<void> {
    const session = this.session;
    if (!session || this.stopped || this.lastFrameAt > armedAt) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.captureMs ?? PHONE_CHROME_CAPTURE_MS);
      timer.unref?.();
    });
    const capture = (async () => {
      const metrics = await session.send('Page.getLayoutMetrics') as { cssVisualViewport?: Record<string, unknown> } | null;
      const vp = metrics?.cssVisualViewport;
      if (!vp || !finite(vp.clientWidth) || !finite(vp.clientHeight) || !finite(vp.pageX) || !finite(vp.pageY)) return null;
      const zoom = vp.zoom === undefined ? 1 : finite(vp.zoom) && vp.zoom > 0 ? vp.zoom : NaN;
      const z = Number.isFinite(zoom) ? zoom : 1;
      const width = vp.clientWidth * z;
      const height = vp.clientHeight * z;
      const scale = Math.min(1, this.size.maxWidth / width, this.size.maxHeight / height);
      const shot = await session.send('Page.captureScreenshot', {
        format: 'jpeg', quality: this.size.quality,
        clip: { x: vp.pageX * z, y: vp.pageY * z, width, height, scale },
      }) as { data?: unknown } | null;
      if (typeof shot?.data !== 'string' || !shot.data) return null;
      const pageScale = finite(vp.scale) ? vp.scale : NaN;
      const geometry = zoom === 1 && pageScale === 1 && !this.navigating
        ? { width: vp.clientWidth, height: vp.clientHeight, scrollX: vp.pageX, scrollY: vp.pageY } : null;
      return { data: shot.data, geometry };
    })();
    capture.catch(() => undefined);
    const shot = await Promise.race([capture.catch(() => null), budget]);
    clearTimeout(timer);
    if (this.stopped || this.lastFrameAt > armedAt) return;
    if (!shot) { this.goHidden(); return; }
    this.geometry = shot.geometry;
    this.offerFrame(shot.data, shot.geometry, undefined);
  }

  /** The session ended: Chrome swapped the page behind the tab (re-attach once), or the tab went. */
  private onClosed(session: ChromeStreamSession): void {
    if (this.stopped || this.session !== session) return;
    this.session = null;
    if (this.reattached) { void this.end('browser-tab-gone'); return; }
    this.reattached = true;
    const retry = setTimeout(() => {
      if (this.stopped) return;
      if (this.chrome.owns && !this.chrome.owns(this.surfaceId, this.workspaceId)) { void this.end('browser-tab-gone'); return; }
      this.attach().catch(() => this.end('browser-tab-gone'));
    }, SWAP_SETTLE_MS);
    retry.unref?.();
  }

  /** Tells the daemon the stream is over, then stops. */
  async end(error: 'browser-tab-gone' | 'browser-preview-unavailable' | 'browser-backend-unavailable'): Promise<void> {
    if (this.stopped) return;
    this.stop();
    await Promise.resolve(this.deps.push({ streamId: this.streamId, kind: 'end', error })).catch(() => undefined);
  }

  /** Stops the screencast and detaches; nothing more is pushed. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.firstFrame) clearTimeout(this.firstFrame);
    for (const item of this.outbox.splice(0)) this.ack(item.ack);
    const session = this.session;
    this.session = null;
    if (session && !session.closed) {
      void session.send('Page.stopScreencast').catch(() => undefined).finally(() => { void session.detach(); });
    }
    this.onStopped(this);
  }
}

/** Main's stream manager for one daemon connection. */
export function createPhoneBrowserStreams(deps: PhoneBrowserStreamDeps): PhoneBrowserStreams {
  const streams = new Map<string, TabStream>();
  const budget = new Budget();
  const key = (workspaceId: string, surfaceId: string) => `${workspaceId}\n${surfaceId}`;
  const forget = (stream: TabStream) => {
    const k = key(stream.workspaceId, stream.surfaceId);
    if (streams.get(k) === stream) streams.delete(k);
  };

  const start = async (payload: Record<string, unknown>): Promise<unknown> => {
    const { streamId, workspaceId, surfaceId } = payload;
    if (typeof streamId !== 'string' || !streamId || streamId.length > 128 || typeof workspaceId !== 'string' || !workspaceId ||
        typeof surfaceId !== 'string' || !surfaceId || surfaceId.length > 128) throw new Error('Invalid browser stream');
    const chrome = deps.chrome;
    if (!surfaceId.startsWith('chrome-')) throw new PhoneBrowserError('browser-action-unsupported');
    if (!chrome?.streamSession || deps.backend() !== 'chrome') throw new PhoneBrowserError('browser-backend-unavailable');
    const tab = (await chrome.tabs(workspaceId)).find((t) => t.surfaceId === surfaceId);
    if (!tab) throw new PhoneBrowserError('browser-tab-gone');
    if (!httpURL(tab.url)) throw new Error('Only HTTP browser previews are supported');
    // The daemon lost track of an earlier stream on this tab: this one replaces it.
    streams.get(key(workspaceId, surfaceId))?.stop();
    if (streams.size >= MAX_TABS) throw new Error('Too many browser streams');
    const stream = new TabStream(
      streamId, workspaceId, surfaceId,
      { maxWidth: clamp(payload.maxWidth, MIN_SIDE, 1920, 1280), maxHeight: clamp(payload.maxHeight, MIN_SIDE, 1920, 1280), quality: clamp(payload.quality, MIN_QUALITY, 85, 60) },
      clamp(payload.maxFps, 1, 15, 10),
      deps, { ...chrome, streamSession: chrome.streamSession.bind(chrome) }, budget, forget,
    );
    streams.set(key(workspaceId, surfaceId), stream);
    try {
      await stream.start();
    } catch (err) {
      stream.stop();
      if (err instanceof ChromePageSessionError) throw new PhoneBrowserError(err.reason === 'gone' ? 'browser-tab-gone' : 'browser-backend-unavailable');
      throw err;
    }
    return { backend: 'chrome', ...stream.size };
  };

  const find = (payload: Record<string, unknown>): TabStream | undefined => {
    if (typeof payload.workspaceId !== 'string' || typeof payload.surfaceId !== 'string') return undefined;
    const stream = streams.get(key(payload.workspaceId, payload.surfaceId));
    return stream && stream.streamId === payload.streamId ? stream : undefined;
  };

  return {
    handle: async (command, payload) => {
      try {
        if (command === 'browser.streamStart') return await start(payload);
        if (command === 'browser.streamUpdate') {
          const stream = find(payload);
          if (stream) stream.maxFps = Math.max(stream.maxFps, clamp(payload.maxFps, 1, 15, stream.maxFps));
          return { applied: stream !== undefined };
        }
        if (command === 'browser.streamStop') {
          const stream = find(payload);
          stream?.stop();
          return { applied: stream !== undefined };
        }
      } catch (err) {
        if (err instanceof PhoneBrowserError) return { error: err.code };
        throw err;
      }
      throw new Error('Unsupported browser operation');
    },
    tab: (surfaceId, workspaceId) => streams.get(key(workspaceId, surfaceId)) ?? null,
    stopAll: () => { for (const stream of [...streams.values()]) stream.stop(); },
  };
}
