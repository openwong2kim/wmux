// ─── The phone's live browser stream, main's side
//
// The daemon asks for a tab's screencast (`browser.streamStart`) when the
// first phone subscribes and stops it (`browser.streamStop`) when the last
// one leaves (src/daemon/web/browserStream.ts). Main runs one screencast per
// tab and pushes what it sees to the daemon over `daemon.phone.browserStream`:
//
//  - `frame`: the JPEG the browser painted, with the page URL and the geometry
//    the phone maps its input with, both left out mid-navigation and the
//    geometry left out under browser zoom or a top offset;
//  - `url`: each committed URL change, ten a second at most; a page that is
//    not http(s) is one without its URL, and none of its frames go out;
//  - `state`: hidden when Chrome reports the tab not visible, or a probe
//    reads it hidden, after five quiet seconds, and at once when the renderer
//    reports a builtin pane off screen; live when frames come back;
//  - `end`: the tab is gone, or its browser is;
//  - `ping`: every 15 s, so a stream the daemon forgot stops here too.
//
// Two sources feed the same stream (TabStream): a dedicated-profile Chrome
// tab, on a CDP session of its own (ChromeLauncher.streamSession), and a
// builtin browser pane, on the debugger WebviewCdpManager attached to its
// <webview>.
//
// One push per tab is in flight at a time, and the browser's frame is acked
// only once the daemon has answered it, so a slow pipe slows the browser down
// instead of queueing. Every push stays inside the control pipe's line limit.

import type { WebContents } from 'electron';
import type { ChromeStreamSession } from '../browser-session/ChromeLauncher';
import { ChromePageSessionError } from '../browser-session/ChromeLauncher';
import type { CdpTargetInfo } from '../browser-session/WebviewCdpManager';
import { readImageSize } from '../../mcp/playwright/imageSize';
import { PhoneBrowserError, type PhoneBrowserBackend } from '../../shared/phoneBrowserPreview';
import { PHONE_CHROME_CAPTURE_MS, viewportOf } from './PhoneBrowserChrome';
import { phoneBrowserViewportExceeds } from './PhoneBrowserGeometry';

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
/** How long before a waiting frame's slot the browser may paint it a fresher one. */
const FRESH_LEAD_MS = 100;
/** How long a page swap is given to bind the tab's new page before re-attaching. */
const SWAP_SETTLE_MS = 500;
/** How long a builtin pane whose debugger let go is given to show it is closing. */
const DETACH_SETTLE_MS = 500;
/** Page swaps re-attached within a minute; one more ends the stream. */
const REATTACH_LIMIT = 3;
const REATTACH_WINDOW_MS = 60_000;
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

/** Main's builtin browser panes, as the stream needs them (main/index.ts, from WebviewCdpManager). */
export interface PhoneStreamBuiltinDeps {
  /** The registered builtin panes (WebviewCdpManager.listTargets). */
  targets(): CdpTargetInfo[];
  /** A pane's guest, or null once it is destroyed. */
  contents(webContentsId: number): WebContents | null;
  /** The renderer's last visibility report for a pane (WebviewCdpManager.isVisible). */
  visible(surfaceId: string): boolean;
  /** Told every visibility change (WebviewCdpManager.onVisibility); returns the unsubscribe. */
  onVisibility(listener: (surfaceId: string, visible: boolean) => void): () => void;
  /** The guest's real widget, in its own CSS pixels (phoneBrowserNativeBounds). */
  nativeBounds(contents: WebContents): Promise<{ width: number; height: number }>;
}

export interface PhoneBrowserStreamDeps {
  /** `daemon.phone.browserStream`; rejects with the daemon's refusal. */
  push(params: Record<string, unknown>): Promise<unknown>;
  backend(): string;
  chrome?: PhoneStreamChromeDeps;
  /** Builtin panes. Absent: only Chrome tabs stream. */
  builtin?: PhoneStreamBuiltinDeps;
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

/**
 * What the budget holds when full: a quarter of a second of either. The
 * bytes held (2 MiB) must stay above STREAM_LINE_LIMIT, or a frame that
 * fits the pipe would never fit the budget and its stream would wait forever.
 */
const BUDGET_BURST_SECONDS = 0.25;

/**
 * Main's push budget across tabs, frames and bytes per second, as token
 * buckets that refill continuously: a stream over budget gets evenly spaced
 * frames, not a second's worth in a burst and then nothing for the rest of it.
 */
class Budget {
  private frames = STREAM_FRAMES_PER_SECOND * BUDGET_BURST_SECONDS;
  private bytes = STREAM_BYTES_PER_SECOND * BUDGET_BURST_SECONDS;
  private at = 0;
  private refill(now: number): void {
    const seconds = Math.max(0, now - this.at) / 1000;
    this.at = now;
    this.frames = Math.min(STREAM_FRAMES_PER_SECOND * BUDGET_BURST_SECONDS, this.frames + seconds * STREAM_FRAMES_PER_SECOND);
    this.bytes = Math.min(STREAM_BYTES_PER_SECOND * BUDGET_BURST_SECONDS, this.bytes + seconds * STREAM_BYTES_PER_SECOND);
  }
  /** Charges one frame of `bytes`; false (nothing charged) past the budget. */
  take(bytes: number, now: number): boolean {
    this.refill(now);
    if (this.frames < 1 || this.bytes < bytes) return false;
    this.frames -= 1;
    this.bytes -= bytes;
    return true;
  }
  /** Milliseconds until a frame of `bytes` fits. */
  wait(bytes: number, now: number): number {
    this.refill(now);
    const frames = Math.max(0, 1 - this.frames) / STREAM_FRAMES_PER_SECOND;
    const data = Math.max(0, bytes - this.bytes) / STREAM_BYTES_PER_SECOND;
    return Math.max(1, Math.ceil(Math.max(frames, data) * 1000));
  }
}

/**
 * One waiting push. `held`: the acks of the frames it replaced, sent when it
 * leaves the outbox (to be pushed, or dropped by a stop). Until then the
 * browser has its two screencast frames unacked and captures no more, so it
 * captures at the pace frames are sent rather than at the page's.
 */
type Outgoing = { kind: 'frame' | 'url' | 'state'; params: Record<string, unknown>; ack?: number; held?: number[]; bytes: number };

interface ScreencastFrame { data?: unknown; metadata?: Record<string, unknown>; sessionId?: unknown }

/**
 * A streamed tab, whichever browser it is in: its URL, the URLs of its
 * document and its latest geometry, and every push to the daemon (pacing,
 * the budget, one push in flight, the ping). A source below attaches to the
 * browser, feeds it the browser's frames and commits, and says when the tab
 * is hidden or gone; the screencast itself is the same CDP on either.
 */
abstract class TabStream implements PhoneStreamTabView {
  url: string | null = null;
  docUrls = new Set<string>();
  geometry: PhoneStreamGeometry | null = null;
  abstract readonly backend: PhoneBrowserBackend;
  protected stopped = false;
  protected navigating = false;
  protected hidden = false;
  protected lastFrameAt = 0;
  private lastPingAt = 0;
  private lastFramePushAt = 0;
  private lastUrlPushAt = 0;
  private inFlight = false;
  private outbox: Outgoing[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private freshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The waiting frame's held acks went out early, once, for this slot (freshen()). */
  private freshened = false;
  private tick: ReturnType<typeof setInterval> | null = null;
  protected firstFrame: ReturnType<typeof setTimeout> | null = null;
  private shrinking = false;
  readonly size: { maxWidth: number; maxHeight: number; quality: number };

  constructor(
    readonly streamId: string,
    readonly workspaceId: string,
    readonly surfaceId: string,
    params: { maxWidth: number; maxHeight: number; quality: number },
    public maxFps: number,
    private readonly deps: PhoneBrowserStreamDeps,
    private readonly budget: Budget,
    private readonly onStopped: (stream: TabStream) => void,
  ) {
    this.size = { ...params };
  }

  /** Attaches to the tab, reads its committed page and starts the screencast. */
  protected abstract attach(): Promise<void>;
  /** One CDP command on the stream's session. */
  protected abstract cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Whether the tab is still this workspace's. */
  protected abstract owned(): boolean;
  /** Whether a frame's metadata maps input here: browser zoom 1, and what else the source knows. */
  protected abstract geometryUsable(): boolean;
  /** The source's own checks, every tick. */
  protected abstract poll(now: number): void;
  /** Lets go of the browser: the screencast and whatever the source listens to. */
  protected abstract release(): void;
  /** Whether the tab is on screen as far as the source knows; painted while not, a frame is not sent. */
  protected visible(): boolean { return true; }

  async start(): Promise<void> {
    await this.attach();
    // Stopped while it attached (replaced, or the daemon left): nothing to run.
    if (this.stopped) throw new ChromePageSessionError('gone', 'stream stopped');
    const now = Date.now();
    this.lastPingAt = now;
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    this.tick.unref?.();
  }

  protected startScreencast(): Promise<unknown> {
    return this.cdp('Page.startScreencast', {
      format: 'jpeg', quality: this.size.quality, maxWidth: this.size.maxWidth, maxHeight: this.size.maxHeight, everyNthFrame: 1,
    });
  }

  protected armFirstFrame(): void {
    if (this.firstFrame) clearTimeout(this.firstFrame);
    const armedAt = Date.now();
    this.firstFrame = setTimeout(() => { this.firstFrame = null; void this.fallbackFrame(armedAt); }, FIRST_FRAME_MS);
    this.firstFrame.unref?.();
  }

  /** A committed main-frame URL: same-document, or a new document. */
  protected commit(raw: unknown, newDocument: boolean): void {
    if (this.stopped) return;
    const url = httpURL(raw);
    if (newDocument || !url) this.docUrls = new Set();
    if (!url) {
      // Not http(s), such as an error page: the phone hears the change without
      // the URL and gets none of its frames, as the preview shows none. Input
      // is refused until an http(s) page commits.
      this.url = null;
      this.enqueue({ kind: 'url', params: { streamId: this.streamId, kind: 'url' }, bytes: 0 });
      return;
    }
    if (url.length <= URL_LIMIT) {
      // The oldest goes first past the cap; the live URL is always the newest.
      this.docUrls.delete(url);
      this.docUrls.add(url);
      while (this.docUrls.size > STREAM_DOC_URLS) this.docUrls.delete(this.docUrls.values().next().value as string);
    }
    this.url = url;
    this.enqueue({ kind: 'url', params: { streamId: this.streamId, kind: 'url', ...(url.length <= URL_LIMIT ? { pageURL: url } : {}) }, bytes: 0 });
  }

  protected onFrame(frame: ScreencastFrame): void {
    const ack = typeof frame.sessionId === 'number' ? frame.sessionId : undefined;
    if (this.stopped) { this.ack(ack); return; }
    // Painted while the source says the tab is off screen: not the phone's to see.
    if (!this.visible()) { this.ack(ack); return; }
    const now = Date.now();
    this.lastFrameAt = now;
    if (this.firstFrame) { clearTimeout(this.firstFrame); this.firstFrame = null; }
    this.geometry = this.geometryOf(frame.metadata);
    if (!this.owned()) { this.ack(ack); void this.end('browser-tab-gone'); return; }
    if (typeof frame.data !== 'string' || !frame.data) { this.ack(ack); return; }
    // A page that is not http(s) (commit()), or a swap not read yet: painted, not sent.
    if (this.url === null) { this.ack(ack); return; }
    if (this.hidden) this.goLive();
    this.offerFrame(frame.data, this.geometry, ack);
  }

  /** The frame's own geometry, or null when input could not land where the phone sees it. */
  private geometryOf(meta: Record<string, unknown> | undefined): PhoneStreamGeometry | null {
    if (!meta || this.navigating || !this.geometryUsable()) return null;
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
      // One step down per restart: frames painted before it are as large.
      if (!this.shrinking) void this.shrink();
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
    this.shrinking = true;
    try {
      await this.cdp('Page.stopScreencast');
      if (!this.stopped) await this.startScreencast();
    } catch { /* the session's own close ends the stream */ } finally {
      this.shrinking = false;
    }
  }

  protected goLive(): void {
    this.hidden = false;
    this.enqueue({ kind: 'state', params: { streamId: this.streamId, kind: 'state', state: 'live' }, bytes: 0 });
  }

  protected goHidden(): void {
    if (this.hidden || this.stopped) return;
    this.hidden = true;
    this.enqueue({ kind: 'state', params: { streamId: this.streamId, kind: 'state', state: 'hidden' }, bytes: 0 });
  }

  /** One waiting push of each kind; a newer one replaces it at the back and holds its frame's ack. */
  private enqueue(item: Outgoing): void {
    if (this.stopped) { this.ack(item.ack); return; }
    const at = this.outbox.findIndex((queued) => queued.kind === item.kind);
    if (at >= 0) {
      const [replaced] = this.outbox.splice(at, 1);
      item.held = [...(replaced.held ?? []), ...(replaced.ack === undefined ? [] : [replaced.ack])];
    }
    this.outbox.push(item);
    this.pump();
  }

  /** The acks a push that left the outbox held for the frames it replaced. */
  private ackHeld(item: Outgoing): void {
    for (const id of item.held ?? []) this.ack(id);
  }

  private pump(): void {
    if (this.inFlight || this.stopped || this.outbox.length === 0) return;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const item = this.outbox[0];
    const now = Date.now();
    let wait = 0;
    if (item.kind === 'frame') {
      wait = this.lastFramePushAt + 1000 / this.maxFps - now;
      if (wait <= 0 && !this.budget.take(item.bytes, now)) wait = this.budget.wait(item.bytes, now);
    } else if (item.kind === 'url') {
      wait = this.lastUrlPushAt + URL_INTERVAL_MS - now;
    }
    if (wait > 0) {
      if (item.kind === 'frame') this.freshen(wait);
      this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, wait);
      this.pumpTimer.unref?.();
      return;
    }
    this.outbox.shift();
    this.ackHeld(item);
    if (item.kind === 'frame') {
      this.lastFramePushAt = now;
      this.freshened = false;
      if (this.freshTimer) { clearTimeout(this.freshTimer); this.freshTimer = null; }
    }
    if (item.kind === 'url') this.lastUrlPushAt = now;
    this.send(item.params, () => {
      // The daemon answered (or refused): only now may the browser paint the next one.
      this.ack(item.ack);
    });
  }

  /**
   * Once per frame sent, FRESH_LEAD_MS before the waiting frame's slot, the
   * acks it holds go out: the browser paints one more, which replaces it and
   * holds its ack, so what is sent is at most about that old rather than as
   * old as the wait. Replacements after that hold until the send, as before.
   */
  private freshen(wait: number): void {
    if (this.freshened || this.freshTimer) return;
    const release = () => {
      this.freshTimer = null;
      this.freshened = true;
      const waiting = this.outbox.find((queued) => queued.kind === 'frame');
      if (waiting) { this.ackHeld(waiting); waiting.held = []; }
    };
    if (wait <= FRESH_LEAD_MS) { release(); return; }
    this.freshTimer = setTimeout(release, wait - FRESH_LEAD_MS);
    this.freshTimer.unref?.();
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

  protected ack(id: number | undefined): void {
    if (id === undefined) return;
    void this.cdp('Page.screencastFrameAck', { sessionId: id }).catch(() => undefined);
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
    this.poll(now);
  }

  /**
   * Nothing painted in the first second (a still page sends no frame until it
   * repaints): one capture instead, within the capture budget. A tab that does
   * not produce even that is hidden.
   */
  private async fallbackFrame(armedAt: number): Promise<void> {
    if (this.stopped || this.lastFrameAt > armedAt || !this.visible()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.captureMs ?? PHONE_CHROME_CAPTURE_MS);
      timer.unref?.();
    });
    const capture = (async () => {
      const metrics = await this.cdp('Page.getLayoutMetrics') as { cssVisualViewport?: Record<string, unknown> } | null;
      const vp = metrics?.cssVisualViewport;
      if (!vp || !finite(vp.clientWidth) || !finite(vp.clientHeight) || !finite(vp.pageX) || !finite(vp.pageY)) return null;
      const zoom = vp.zoom === undefined ? 1 : finite(vp.zoom) && vp.zoom > 0 ? vp.zoom : NaN;
      const z = Number.isFinite(zoom) ? zoom : 1;
      const width = vp.clientWidth * z;
      const height = vp.clientHeight * z;
      const scale = Math.min(1, this.size.maxWidth / width, this.size.maxHeight / height);
      const shot = await this.cdp('Page.captureScreenshot', {
        format: 'jpeg', quality: this.size.quality,
        clip: { x: vp.pageX * z, y: vp.pageY * z, width, height, scale },
      }) as { data?: unknown } | null;
      if (typeof shot?.data !== 'string' || !shot.data) return null;
      const pageScale = finite(vp.scale) ? vp.scale : NaN;
      const geometry = zoom === 1 && pageScale === 1 && !this.navigating && this.geometryUsable()
        ? { width: vp.clientWidth, height: vp.clientHeight, scrollX: vp.pageX, scrollY: vp.pageY } : null;
      return { data: shot.data, geometry };
    })();
    capture.catch(() => undefined);
    const shot = await Promise.race([capture.catch(() => null), budget]);
    clearTimeout(timer);
    if (this.stopped || this.lastFrameAt > armedAt || !this.visible()) return;
    if (!shot) { this.goHidden(); return; }
    if (this.url === null) return;
    this.geometry = shot.geometry;
    if (this.hidden) this.goLive();
    this.offerFrame(shot.data, shot.geometry, undefined);
  }

  /** Tells the daemon the stream is over, then stops. */
  async end(error: 'browser-tab-gone' | 'browser-preview-unavailable' | 'browser-backend-unavailable'): Promise<void> {
    if (this.stopped) return;
    this.stop();
    await Promise.resolve(this.deps.push({ streamId: this.streamId, kind: 'end', error })).catch(() => undefined);
  }

  /** Stops the screencast and lets go of the browser; nothing more is pushed. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.freshTimer) clearTimeout(this.freshTimer);
    if (this.firstFrame) clearTimeout(this.firstFrame);
    for (const item of this.outbox.splice(0)) { this.ackHeld(item); this.ack(item.ack); }
    this.release();
    this.onStopped(this);
  }
}

/** A dedicated-profile Chrome tab, on a CDP session of its own. */
class ChromeTabStream extends TabStream {
  readonly backend = 'chrome';
  private session: ChromeStreamSession | null = null;
  private mainFrameId: string | null = null;
  private zoom = 1;
  private invisibleSince: number | null = null;
  private lastZoomAt = 0;
  private lastProbeAt = 0;
  private reattachedAt: number[] = [];

  constructor(
    streamId: string,
    workspaceId: string,
    surfaceId: string,
    params: { maxWidth: number; maxHeight: number; quality: number },
    maxFps: number,
    deps: PhoneBrowserStreamDeps,
    private readonly chrome: PhoneStreamChromeDeps & Required<Pick<PhoneStreamChromeDeps, 'streamSession'>>,
    budget: Budget,
    onStopped: (stream: TabStream) => void,
  ) {
    super(streamId, workspaceId, surfaceId, params, maxFps, deps, budget, onStopped);
  }

  /** `swap`: Chrome swapped the page behind the tab; the new page is a commit of its own. */
  protected async attach(swap = false): Promise<void> {
    const session = await this.chrome.streamSession(this.surfaceId, this.workspaceId);
    if (this.stopped) { void session.detach(); return; }
    this.session = session;
    session.on('Page.screencastFrame', (p) => {
      this.invisibleSince = null;
      this.onFrame(p as ScreencastFrame);
    });
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
    // The tree is the committed page: a navigation the old page started is over.
    this.navigating = false;
    const raw = `${String(frame.url ?? '')}${typeof frame.urlFragment === 'string' ? frame.urlFragment : ''}`;
    if (swap) {
      this.commit(raw, true);
    } else {
      const url = httpURL(raw);
      if (!url) throw new Error('Only HTTP browser previews are supported');
      this.url = url;
      this.docUrls = new Set(url.length <= URL_LIMIT ? [url] : []);
    }
    await this.readZoom();
    await this.startScreencast();
    this.armFirstFrame();
  }

  protected cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.session) return Promise.reject(new ChromePageSessionError('gone', 'stream session ended'));
    return this.session.send(method, params);
  }

  protected owned(): boolean {
    return !this.chrome.owns || this.chrome.owns(this.surfaceId, this.workspaceId);
  }

  protected geometryUsable(): boolean {
    return this.zoom === 1;
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

  protected poll(now: number): void {
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

  /** The session ended: Chrome swapped the page behind the tab (re-attach), or the tab went. */
  private onClosed(session: ChromeStreamSession): void {
    if (this.stopped || this.session !== session) return;
    this.session = null;
    // The re-attach arms its own first frame; the old page's capture has no session to run on.
    if (this.firstFrame) { clearTimeout(this.firstFrame); this.firstFrame = null; }
    // Until the new page is read, input checks the live page itself (PhoneBrowser.ts).
    this.url = null;
    const now = Date.now();
    this.reattachedAt = this.reattachedAt.filter((at) => now - at < REATTACH_WINDOW_MS);
    if (this.reattachedAt.length >= REATTACH_LIMIT) { void this.end('browser-tab-gone'); return; }
    this.reattachedAt.push(now);
    const retry = setTimeout(() => {
      if (this.stopped) return;
      if (this.chrome.owns && !this.chrome.owns(this.surfaceId, this.workspaceId)) { void this.end('browser-tab-gone'); return; }
      this.attach(true).catch((err: unknown) => this.end(
        !(err instanceof ChromePageSessionError) ? 'browser-preview-unavailable' : err.reason === 'gone' ? 'browser-tab-gone' : 'browser-backend-unavailable',
      ));
    }, SWAP_SETTLE_MS);
    retry.unref?.();
  }

  protected release(): void {
    const session = this.session;
    this.session = null;
    if (session && !session.closed) {
      void session.send('Page.stopScreencast').catch(() => undefined).finally(() => { void session.detach(); });
    }
  }
}

/**
 * A builtin browser pane: its <webview>'s guest, on the debugger
 * WebviewCdpManager attached. It takes no automation lease (a lease shows the
 * "agent is driving" marker), so lightweight mode may throttle the pane while
 * it is off screen, and discard it, which ends the stream.
 */
class BuiltinTabStream extends TabStream {
  readonly backend = 'builtin';
  /** The visible viewport is larger than the real widget (an emulated one): input cannot reach all of it. */
  private exceeds = false;
  private lastBoundsAt = 0;
  private readonly unlisten: Array<() => void> = [];

  constructor(
    streamId: string,
    workspaceId: string,
    surfaceId: string,
    params: { maxWidth: number; maxHeight: number; quality: number },
    maxFps: number,
    deps: PhoneBrowserStreamDeps,
    private readonly builtin: PhoneStreamBuiltinDeps,
    private readonly wc: WebContents,
    budget: Budget,
    onStopped: (stream: TabStream) => void,
  ) {
    super(streamId, workspaceId, surfaceId, params, maxFps, deps, budget, onStopped);
  }

  protected async attach(): Promise<void> {
    const wc = this.wc;
    if (wc.isDestroyed()) throw new PhoneBrowserError('browser-tab-gone');
    // The committed page, and every event after it: nothing commits in between.
    const url = httpURL(wc.getURL());
    if (!url) throw new Error('Only HTTP browser previews are supported');
    this.url = url;
    this.docUrls = new Set(url.length <= URL_LIMIT ? [url] : []);
    const dbg = wc.debugger;
    // The page's own session only (a child target's has its id).
    const onMessage = (_event: Electron.Event, method: string, params: ScreencastFrame, sessionId: string) => {
      if (method === 'Page.screencastFrame' && !sessionId) this.onFrame(params);
    };
    const onDetach = () => this.onDetached();
    const onDestroyed = () => { void this.end('browser-tab-gone'); };
    const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) this.navigating = true;
    };
    const onNavigate = (_event: Electron.Event, raw: string) => this.onNavigated(raw);
    // A load that failed commits its error page at the URL it was for, as wc.getURL() and the capture have it.
    const onFailed = (_event: Electron.Event, _code: number, _description: string, raw: string, isMainFrame: boolean) => {
      if (isMainFrame) this.onNavigated(raw);
    };
    const onInPage = (_event: Electron.Event, raw: string, isMainFrame: boolean) => { if (isMainFrame) this.commit(raw, false); };
    const onStopLoading = () => { this.navigating = false; };
    dbg.on('message', onMessage);
    dbg.on('detach', onDetach);
    wc.on('destroyed', onDestroyed);
    wc.on('did-start-navigation', onStart);
    wc.on('did-navigate', onNavigate);
    wc.on('did-fail-provisional-load', onFailed);
    wc.on('did-navigate-in-page', onInPage);
    wc.on('did-stop-loading', onStopLoading);
    this.unlisten.push(() => {
      dbg.off('message', onMessage);
      dbg.off('detach', onDetach);
      wc.off('destroyed', onDestroyed);
      wc.off('did-start-navigation', onStart);
      wc.off('did-navigate', onNavigate);
      wc.off('did-fail-provisional-load', onFailed);
      wc.off('did-navigate-in-page', onInPage);
      wc.off('did-stop-loading', onStopLoading);
    });
    this.unlisten.push(this.builtin.onVisibility((surfaceId, visible) => {
      if (surfaceId === this.surfaceId) this.onVisibility(visible);
    }));
    await this.readBounds();
    await this.startScreencast();
    if (!this.visible()) { this.goHidden(); return; }
    // Chromium paints a visible guest's first screencast frame itself; the
    // repaint is a nudge, and the fallback capture is what guarantees one.
    this.repaint();
    this.armFirstFrame();
  }

  protected cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      if (this.wc.isDestroyed()) throw new Error('Browser unavailable');
      return this.wc.debugger.sendCommand(method, params);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  protected owned(): boolean {
    if (this.wc.isDestroyed()) return false;
    const id = this.wc.id;
    return this.builtin.targets().some((t) => t.surfaceId === this.surfaceId && t.webContentsId === id && t.workspaceId === this.workspaceId);
  }

  /** The metadata is in device-independent pixels: CSS pixels only at zoom 1 (the capture's geometry is CSS). */
  protected geometryUsable(): boolean {
    return !this.exceeds && !this.wc.isDestroyed() && this.wc.getZoomFactor() === 1;
  }

  protected visible(): boolean {
    return this.builtin.visible(this.surfaceId);
  }

  protected poll(now: number): void {
    // Unregistered with its guest alive (discarded to free memory, or replaced): no event of the guest's says so.
    if (!this.owned()) { void this.end('browser-tab-gone'); return; }
    if (now - this.lastFrameAt < ZOOM_POLL_MS && now - this.lastBoundsAt >= ZOOM_POLL_MS) void this.readBounds();
  }

  private onNavigated(raw: unknown): void {
    this.navigating = false;
    this.commit(raw, true);
    void this.readBounds();
  }

  /** Off screen: hidden at once. Back: `live` comes with the next frame, forced if the page is still. */
  private onVisibility(visible: boolean): void {
    if (this.stopped) return;
    if (!visible) { this.goHidden(); return; }
    if (!this.hidden) return;
    this.repaint();
    this.armFirstFrame();
  }

  /**
   * The debugger let go of the guest. A closing pane lets go before its guest
   * is destroyed, and an unregistered one (discarded, replaced) without being
   * destroyed at all, so the cause is read a moment later: the pane is gone,
   * or something else took the debugger (DevTools).
   */
  private onDetached(): void {
    if (this.stopped) return;
    const settle = setTimeout(() => {
      void this.end(this.owned() ? 'browser-preview-unavailable' : 'browser-tab-gone');
    }, DETACH_SETTLE_MS);
    settle.unref?.();
  }

  private repaint(): void {
    try { if (!this.wc.isDestroyed()) this.wc.invalidate(); } catch { /* best effort */ }
  }

  private async readBounds(): Promise<void> {
    this.lastBoundsAt = Date.now();
    try {
      const viewport = viewportOf(await this.cdp('Page.getLayoutMetrics'));
      this.exceeds = phoneBrowserViewportExceeds(viewport, await this.builtin.nativeBounds(this.wc));
    } catch { /* kept as it was */ }
  }

  protected release(): void {
    for (const off of this.unlisten.splice(0)) off();
    if (!this.wc.isDestroyed()) void this.cdp('Page.stopScreencast').catch(() => undefined);
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
    const size = { maxWidth: clamp(payload.maxWidth, MIN_SIDE, 1920, 1280), maxHeight: clamp(payload.maxHeight, MIN_SIDE, 1920, 1280), quality: clamp(payload.quality, MIN_QUALITY, 85, 60) };
    const maxFps = clamp(payload.maxFps, 1, 15, 10);
    let create: () => TabStream;
    if (surfaceId.startsWith('chrome-')) {
      const chrome = deps.chrome;
      if (!chrome?.streamSession || deps.backend() !== 'chrome') throw new PhoneBrowserError('browser-backend-unavailable');
      const tab = (await chrome.tabs(workspaceId)).find((t) => t.surfaceId === surfaceId);
      if (!tab) throw new PhoneBrowserError('browser-tab-gone');
      if (!httpURL(tab.url)) throw new Error('Only HTTP browser previews are supported');
      const session = { ...chrome, streamSession: chrome.streamSession.bind(chrome) };
      create = () => new ChromeTabStream(streamId, workspaceId, surfaceId, size, maxFps, deps, session, budget, forget);
    } else {
      // A builtin pane of this workspace, whatever the backend setting, as
      // the preview finds it (PhoneBrowser.ts driverFor).
      const builtin = deps.builtin;
      if (!builtin) throw new PhoneBrowserError('browser-action-unsupported');
      const target = builtin.targets().find((t) => t.surfaceId === surfaceId && t.workspaceId === workspaceId);
      const wc = target ? builtin.contents(target.webContentsId) : null;
      if (!wc || wc.isDestroyed()) throw new PhoneBrowserError('browser-tab-gone');
      if (!httpURL(wc.getURL())) throw new Error('Only HTTP browser previews are supported');
      create = () => new BuiltinTabStream(streamId, workspaceId, surfaceId, size, maxFps, deps, builtin, wc, budget, forget);
    }
    // The daemon lost track of an earlier stream on this tab: this one replaces it.
    streams.get(key(workspaceId, surfaceId))?.stop();
    if (streams.size >= MAX_TABS) throw new Error('Too many browser streams');
    const stream = create();
    streams.set(key(workspaceId, surfaceId), stream);
    try {
      await stream.start();
    } catch (err) {
      stream.stop();
      if (err instanceof ChromePageSessionError) throw new PhoneBrowserError(err.reason === 'gone' ? 'browser-tab-gone' : 'browser-backend-unavailable');
      throw err;
    }
    return { backend: stream.backend, ...stream.size };
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
