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
//  - `focus`: whether the focused element takes typed text, and its kind, on
//    each change (PhoneBrowserFocus.watchFocus), ten a second at most;
//  - `end`: the tab is gone, or its browser is;
//  - `ping`: every 15 s, so a stream the daemon forgot stops here too.
//
// While the daemon says a subscriber asked for `viewport=mobile`
// (`mobile` on browser.streamStart and browser.streamUpdate), the tab emulates
// a phone: Chrome on the stream's own session, which Chrome undoes when the
// session detaches; a builtin pane through the phone's own viewport action,
// undone by the stream only while that preset is still the one it set.
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
import { electronFocusCdp, watchFocus, type FocusCdp, type FocusWatch } from './PhoneBrowserFocus';
import { PHONE_WIDTH, phoneBrowserViewportExceeds, phoneFillScale, presetViewScale } from './PhoneBrowserGeometry';

const STREAM_ENV = 'WMUX_PHONE_BROWSER_STREAM';

/** Whether this desktop offers the phone browser stream: on unless `WMUX_PHONE_BROWSER_STREAM=0` (the kill switch). */
export function phoneBrowserStreamEnabled(): boolean {
  return process.env[STREAM_ENV] !== '0';
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
/** A mobile change that failed is tried again after this. */
const MOBILE_RETRY_MS = 2_000;
/** How long a new stream on a tab waits for the stream before it to let go (its mobile revert). */
const RELEASE_WAIT_MS = 3_000;
const QUIET_MS = 5_000;
const PING_MS = 15_000;
const URL_INTERVAL_MS = 100;
const TICK_MS = 500;
const PUSH_TIMEOUT_MS = 3_000;
/** Sends of one url, focus or state push that failed before it is given up. */
const PUSH_RETRIES = 5;
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
/** The phone a Chrome tab emulates for `viewport=mobile`, bounded by the real tab. */
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const MOBILE_SCALE = 2;
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
  /**
   * The phone's viewport action on a pane (PhoneBrowser.ts `browser.viewport`)
   * with `fill`: `mobile` draws a phone's viewport larger to fill the pane;
   * `refit` fits the phone already there to the pane's new size, without a reload.
   */
  viewport(surfaceId: string, workspaceId: string, mode: 'mobile' | 'desktop', refit?: boolean): Promise<void>;
  /** The device preset browser.emulate last set on the guest, while it holds (browser.rpc.ts activeDevicePreset); `scale`: drawn that much larger. */
  preset(contents: WebContents): { readonly mobile: boolean; readonly scale?: number; readonly fill?: true } | undefined;
  /** Takes the guest's device preset off, as the `desktop` viewport action does, on any page and while the user holds the pane (browser.rpc.ts resetDevicePreset). */
  reset(contents: WebContents): Promise<void>;
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
 *
 * A tab refused a frame waits in line, and no tab is served before the ones
 * refused ahead of it: otherwise tabs of small frames take the bytes as they
 * refill, and a tab of large frames never sees enough of them at once.
 */
class Budget {
  private frames = STREAM_FRAMES_PER_SECOND * BUDGET_BURST_SECONDS;
  private bytes = STREAM_BYTES_PER_SECOND * BUDGET_BURST_SECONDS;
  private at = 0;
  /** The tabs refused a frame, in the order they were refused, with that frame's size. */
  private line: Array<{ who: object; bytes: number; wake: () => void }> = [];
  private refill(now: number): void {
    const seconds = Math.max(0, now - this.at) / 1000;
    this.at = now;
    this.frames = Math.min(STREAM_FRAMES_PER_SECOND * BUDGET_BURST_SECONDS, this.frames + seconds * STREAM_FRAMES_PER_SECOND);
    this.bytes = Math.min(STREAM_BYTES_PER_SECOND * BUDGET_BURST_SECONDS, this.bytes + seconds * STREAM_BYTES_PER_SECOND);
  }
  /**
   * Charges one frame of `bytes` to `who`; false (nothing charged) past the
   * budget, or while a tab refused earlier still waits. `wake` asks `who` to
   * try again once it is first in line.
   */
  take(who: object, bytes: number, now: number, wake: () => void): boolean {
    this.refill(now);
    const place = this.line.findIndex((waiting) => waiting.who === who);
    if (place >= 0) this.line[place].bytes = bytes;
    const passing = place < 0 ? this.line.length > 0 : place > 0;
    if (passing || this.frames < 1 || this.bytes < bytes) {
      if (place < 0) this.line.push({ who, bytes, wake });
      return false;
    }
    this.frames -= 1;
    this.bytes -= bytes;
    if (place === 0) {
      this.line.shift();
      this.next();
    }
    return true;
  }
  /** Milliseconds until `who`'s frame fits, after the frames of the tabs ahead of it. */
  wait(who: object, bytes: number, now: number): number {
    this.refill(now);
    let frames = 1;
    let data = bytes;
    for (const waiting of this.line) {
      if (waiting.who === who) break;
      frames += 1;
      data += waiting.bytes;
    }
    const frameWait = Math.max(0, frames - this.frames) / STREAM_FRAMES_PER_SECOND;
    const dataWait = Math.max(0, data - this.bytes) / STREAM_BYTES_PER_SECOND;
    return Math.max(1, Math.ceil(Math.max(frameWait, dataWait) * 1000));
  }
  /** `who` stopped: it leaves the line. */
  leave(who: object): void {
    const place = this.line.findIndex((waiting) => waiting.who === who);
    if (place < 0) return;
    this.line.splice(place, 1);
    if (place === 0) this.next();
  }
  /** The first in line has gone: the next one tries now rather than at its estimate. */
  private next(): void {
    const first = this.line[0];
    if (first) queueMicrotask(first.wake);
  }
}

/**
 * One waiting push. `held`: the acks of the frames it replaced, sent when it
 * leaves the outbox (to be pushed, or dropped by a stop). Until then the
 * browser has its two screencast frames unacked and captures no more, so it
 * captures at the pace frames are sent rather than at the page's.
 */
type Outgoing = { kind: 'frame' | 'url' | 'state' | 'focus'; params: Record<string, unknown>; ack?: number; held?: number[]; bytes: number; retries?: number };

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
  private lastFocusPushAt = 0;
  private inFlight = false;
  /** The tab's focus watcher on the source's current session (contract v1.6). */
  private focusWatch: FocusWatch | null = null;
  private outbox: Outgoing[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private freshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The waiting frame's held acks went out early, once, for this slot (freshen()). */
  private freshened = false;
  private tick: ReturnType<typeof setInterval> | null = null;
  protected firstFrame: ReturnType<typeof setTimeout> | null = null;
  private shrinking = false;
  /** The budget's call once this tab is first in its line (Budget.take). */
  private readonly wake = () => this.pump();
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
  /** Lets go of the browser; `unwatched` settles once the focus watcher's teardown, which uses the session, is done. Settles once the tab is let go. */
  protected abstract release(unwatched: Promise<void>): Promise<void>;
  /** Whether the tab is on screen as far as the source knows; painted while not, a frame is not sent. */
  protected visible(): boolean { return true; }
  /** Emulates a phone on the tab (`viewport=mobile`). */
  protected abstract applyMobile(): Promise<void>;
  /** Undoes applyMobile. */
  protected abstract clearMobile(): Promise<void>;

  /** Whether the daemon asks for a phone's viewport on the tab; the source follows it once attached. */
  mobileWanted = false;
  /** Whether the source emulates a phone on the tab, as the stream asked. */
  protected mobile = false;
  /** Mobile changes run one at a time, in order. */
  private mobileQueue: Promise<void> = Promise.resolve();
  private mobileRetryAt = 0;
  /** Settles once a stopped stream let go of the tab, its mobile revert included; never rejects. */
  released: Promise<void> = Promise.resolve();

  /** The daemon's `mobile` (browser.streamUpdate). */
  setMobile(want: boolean): Promise<void> {
    this.mobileWanted = want;
    return this.syncMobile();
  }

  /** Runs `change` after the mobile changes before it; never rejects. */
  protected mobileStep(change: () => Promise<void>): Promise<void> {
    const run = this.mobileQueue.then(change).catch(() => undefined);
    this.mobileQueue = run;
    return run;
  }

  /** Brings the tab to what the daemon last asked for. A change that fails leaves it as it was; the next one tries again. */
  protected syncMobile(): Promise<void> {
    return this.mobileStep(async () => {
      if (this.stopped) return;
      if (this.mobileWanted && !this.mobile) {
        await this.applyMobile();
        this.mobile = true;
      } else if (!this.mobileWanted && this.mobile) {
        await this.clearMobile();
        this.mobile = false;
      }
    });
  }

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
    // A view drawn larger than its layout: the frame's DIP size back in CSS pixels.
    const view = this.viewScale();
    const css = (dip: number) => view === 1 ? dip : Math.round((dip / view) * 1000) / 1000;
    return { width: css(deviceWidth), height: css(deviceHeight), scrollX: scrollOffsetX, scrollY: scrollOffsetY, ...(scale !== 1 ? { scale } : {}) };
  }

  /** How much larger than its layout the tab is drawn (an emulated scale); 1 unless a source says so. */
  protected viewScale(): number {
    return 1;
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
      if (wait <= 0 && !this.budget.take(this, item.bytes, now, this.wake)) wait = this.budget.wait(this, item.bytes, now);
    } else if (item.kind === 'url') {
      wait = this.lastUrlPushAt + URL_INTERVAL_MS - now;
    } else if (item.kind === 'focus') {
      wait = this.lastFocusPushAt + URL_INTERVAL_MS - now;
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
    if (item.kind === 'focus') this.lastFocusPushAt = now;
    this.send(item, () => {
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

  /**
   * One push in flight; `known:false` stops here. A refused frame is a dropped
   * one. A refused url, focus or state push goes back to the front, in its
   * place before the frames after it, unless a newer one of its kind waits:
   * the last of each must arrive.
   */
  private send(item: Outgoing, done: () => void): void {
    this.inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('push timed out')), PUSH_TIMEOUT_MS);
      timer.unref?.();
    });
    Promise.race([this.deps.push(item.params), timeout]).then((reply) => {
      if ((reply as { known?: unknown } | null)?.known === false) this.stop();
    }, () => {
      // Rate limited, timed out or disconnected; the ping decides the rest.
      const retries = (item.retries ?? 0) + 1;
      if (item.kind === 'frame' || this.stopped || retries > PUSH_RETRIES) return;
      if (this.outbox.some((queued) => queued.kind === item.kind)) return;
      this.outbox.unshift({ ...item, retries });
    }).finally(() => {
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
    // The daemon sends `mobile` only when it changes: a change that failed is tried again here.
    if (this.mobileWanted !== this.mobile && now - this.mobileRetryAt >= MOBILE_RETRY_MS) {
      this.mobileRetryAt = now;
      void this.syncMobile();
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

  /**
   * Watches the tab's focus on the source's session and pushes each change
   * (`{kind:'focus', focus:{editable, kind?}}`; the push's own `kind` is
   * taken). `current`: whether that session is still the source's once the
   * watcher is installed. A stop or a swap meanwhile keeps none running.
   * Without a watcher the stream goes on, with no focus events.
   */
  protected async watchFocusOn(cdp: FocusCdp, current: () => boolean): Promise<void> {
    if (this.stopped) return;
    const watch = await watchFocus(cdp, (focus) => {
      this.enqueue({ kind: 'focus', params: { streamId: this.streamId, kind: 'focus', focus }, bytes: 0 });
    }).catch(() => null);
    if (!watch) return;
    if (this.stopped || !current()) { void watch.stop(); return; }
    void this.dropFocusWatch();
    this.focusWatch = watch;
  }

  /** The focus watcher stops: its detectors, its binding and its timer go. Settles when they have. */
  protected dropFocusWatch(): Promise<void> {
    const watch = this.focusWatch;
    this.focusWatch = null;
    return watch ? watch.stop().catch(() => undefined) : Promise.resolve();
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
    this.budget.leave(this);
    this.released = this.release(this.dropFocusWatch());
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
    // The first frame at the phone's size; a page swap's new session has none of the old one's emulation.
    await this.syncMobile();
    await this.startScreencast();
    this.armFirstFrame();
    void this.watchFocusOn(session, () => this.session === session);
  }

  /** A phone's viewport at the real tab's size or less (visual viewport × pinch scale × browser zoom), with touch. */
  protected async applyMobile(): Promise<void> {
    const session = this.session;
    if (!session) throw new ChromePageSessionError('gone', 'stream session ended');
    const vp = viewportOf(await session.send('Page.getLayoutMetrics'));
    const size = (Number.isFinite(vp.scale) && vp.scale > 0 ? vp.scale : 1) * (Number.isFinite(vp.zoom) ? vp.zoom : 1);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: Math.min(MOBILE_WIDTH, Math.floor(vp.width * size)), height: Math.min(MOBILE_HEIGHT, Math.floor(vp.height * size)),
      deviceScaleFactor: MOBILE_SCALE, mobile: true,
    });
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // Swapped meanwhile: that session took its emulation with it, and the re-attach applies it anew.
    if (this.session !== session) throw new ChromePageSessionError('gone', 'stream session ended');
  }

  protected async clearMobile(): Promise<void> {
    await this.cdp('Emulation.clearDeviceMetricsOverride');
    await this.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
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
    // Chrome undid the session's emulation as it detached; the re-attach applies it again.
    this.mobile = false;
    // The watcher went with the session; the re-attach starts another.
    void this.dropFocusWatch();
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

  protected release(unwatched: Promise<void>): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session || session.closed) return Promise.resolve();
    // The focus watcher's teardown runs on this session: it goes first.
    // Detaching takes the session's emulation with it.
    return unwatched.then(() => session.send('Page.stopScreencast')).catch(() => undefined)
      .then(() => session.detach()).catch(() => undefined);
  }
}

/**
 * A builtin browser pane: its <webview>'s guest, on the debugger
 * WebviewCdpManager attached. Streaming takes no automation lease (a lease
 * shows the "agent is driving" marker), so lightweight mode may throttle the
 * pane while it is off screen, and discard it, which ends the stream. Only
 * `viewport=mobile` does: its apply is the phone's viewport action, which
 * holds a lease while it runs.
 */
/** net::ERR_ABORTED: a navigation that ended without committing anything. */
const NET_ERR_ABORTED = -3;

class BuiltinTabStream extends TabStream {
  readonly backend = 'builtin';
  /** The visible viewport is larger than the real widget (an emulated one): input cannot reach all of it. */
  private exceeds = false;
  private lastBoundsAt = 0;
  private readonly unlisten: Array<() => void> = [];
  /** The device preset the stream put on the pane; it is reverted only while it is still the pane's. */
  private ownPreset: object | null = null;
  private lastRefitAt = 0;

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
    // A load that failed commits its error page at the URL it was for, as
    // wc.getURL() and the capture have it. An aborted one (a download, a 204,
    // an external app link, a load another one replaced) commits nothing:
    // the page on screen is still the one before.
    const onFailed = (_event: Electron.Event, code: number, _description: string, _raw: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.navigating = false;
      if (code === NET_ERR_ABORTED || wc.isDestroyed()) return;
      const committed = wc.getURL();
      if (httpURL(committed) !== this.url) this.onNavigated(committed);
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
    // Stopped meanwhile (release() has run): start nothing it would not stop.
    if (this.stopped) return;
    // The first frame at the phone's size.
    await this.syncMobile();
    if (this.stopped) return;
    await this.startScreencast();
    if (this.stopped) { void this.cdp('Page.stopScreencast').catch(() => undefined); return; }
    // On the debugger WebviewCdpManager attached, shared: the watcher never
    // disables a domain on it, and takes its binding and detector back on stop.
    void this.watchFocusOn(electronFocusCdp(wc.debugger), () => !wc.isDestroyed());
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

  /**
   * The pane's preset right after the stream's viewport action, when it is
   * that action's: an agent's emulation landing while the action awaits its
   * probe is the agent's, never adopted (and never reverted) by the stream.
   */
  private fillPreset(): object | null {
    const preset = this.builtin.preset(this.wc);
    return preset?.fill ? preset : null;
  }

  /** The stream's phone fills the pane: drawn this much larger than its 390 CSS px. */
  protected viewScale(): number {
    return presetViewScale(this.builtin.preset(this.wc));
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
    // While mobile, also on a still page: the pane may shrink under the emulated viewport.
    if ((now - this.lastFrameAt < ZOOM_POLL_MS || this.mobile) && now - this.lastBoundsAt >= ZOOM_POLL_MS) void this.readBounds();
  }

  /**
   * The phone's own viewport action, which draws the phone larger to fill
   * the pane (it reloads the page). A phone preset already on the pane (the phone's
   * viewport action, an agent's emulation) is kept as it is and not the
   * stream's. Any other preset (an agent's desktop one) is replaced, and the
   * stream's own then reverts to no preset at all.
   */
  protected async applyMobile(): Promise<void> {
    if (!this.builtin.preset(this.wc)?.mobile) {
      await this.builtin.viewport(this.surfaceId, this.workspaceId, 'mobile');
      this.ownPreset = this.fillPreset();
    }
    await this.readBounds();
  }

  protected async clearMobile(): Promise<void> {
    await this.revertMobile();
    await this.readBounds();
  }

  /**
   * Back to the desktop viewport, only while the pane's preset is the one the
   * stream set: a viewport action or an agent's emulation since is theirs.
   * The preset stays the stream's until the reset succeeds, so a failed one
   * is tried again.
   */
  private async revertMobile(): Promise<void> {
    const own = this.ownPreset;
    if (!own) return;
    if (this.wc.isDestroyed() || this.builtin.preset(this.wc) !== own) { this.ownPreset = null; return; }
    await this.builtin.reset(this.wc);
    this.ownPreset = null;
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
      const native = await this.builtin.nativeBounds(this.wc);
      const view = this.viewScale();
      // As drawn: the visual viewport times its pinch scale (a page without a viewport meta lays out wider at a scale below 1), times the view's.
      const drawn = { width: viewport.width * viewport.scale * view, height: viewport.height * viewport.scale * view };
      this.exceeds = phoneBrowserViewportExceeds({ ...viewport, scale: viewport.scale * view }, native);
      // The pane resized under the stream's phone: fit it again, so it fills the pane and input reaches all of it.
      const own = this.ownPreset;
      const fill = phoneFillScale(native);
      if (own && this.mobile && !this.stopped && this.builtin.preset(this.wc) === own && Date.now() - this.lastRefitAt >= MOBILE_RETRY_MS &&
          (Math.abs(fill - view) * PHONE_WIDTH > 1 ||
           Math.abs(drawn.width - Math.min(PHONE_WIDTH, native.width) * fill) > view + 1 ||
           Math.abs(drawn.height - native.height) > view + 1)) {
        this.lastRefitAt = Date.now();
        void this.mobileStep(() => this.refit());
      }
    } catch { /* kept as it was */ }
  }

  /** The stream's own phone, fitted again to the pane's size; a phone the user or an agent set since is theirs. */
  private async refit(): Promise<void> {
    const own = this.ownPreset;
    if (this.stopped || !own || this.wc.isDestroyed() || this.builtin.preset(this.wc) !== own) return;
    await this.builtin.viewport(this.surfaceId, this.workspaceId, 'mobile', true);
    this.ownPreset = this.fillPreset();
    await this.readBounds();
  }

  protected release(): Promise<void> {
    // The pane's debugger stays attached: the focus watcher's teardown needs no wait.
    for (const off of this.unlisten.splice(0)) off();
    if (!this.wc.isDestroyed()) void this.cdp('Page.stopScreencast').catch(() => undefined);
    // After a change still running: its preset is the one to revert.
    return this.mobileStep(() => this.revertMobile());
  }
}

/** Main's stream manager for one daemon connection. */
export function createPhoneBrowserStreams(deps: PhoneBrowserStreamDeps): PhoneBrowserStreams {
  const streams = new Map<string, TabStream>();
  /** A stopped stream's let-go per tab, until it settles: a new stream on the tab waits for it, so the old revert cannot land after the new apply. */
  const releasing = new Map<string, Promise<void>>();
  const budget = new Budget();
  const key = (workspaceId: string, surfaceId: string) => `${workspaceId}\n${surfaceId}`;
  const forget = (stream: TabStream) => {
    const k = key(stream.workspaceId, stream.surfaceId);
    if (streams.get(k) === stream) streams.delete(k);
    const released = stream.released;
    releasing.set(k, released);
    void released.then(() => { if (releasing.get(k) === released) releasing.delete(k); });
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
    stream.mobileWanted = payload.mobile === true;
    streams.set(key(workspaceId, surfaceId), stream);
    try {
      const before = releasing.get(key(workspaceId, surfaceId));
      if (before) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([before, new Promise<void>((resolve) => { timer = setTimeout(resolve, RELEASE_WAIT_MS); })]);
        clearTimeout(timer);
      }
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
          if (stream && typeof payload.mobile === 'boolean') void stream.setMobile(payload.mobile);
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
