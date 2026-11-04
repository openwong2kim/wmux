import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChromeStreamSession } from '../../browser-session/ChromeLauncher';
import { ChromePageSessionError } from '../../browser-session/ChromeLauncher';
import { createPhoneBrowserStreams, phoneBrowserStreamEnabled, STREAM_LINE_LIMIT, type PhoneBrowserStreamDeps, type PhoneBrowserStreams } from '../PhoneBrowserStream';
import { WATCH_FOCUS_EXPRESSION } from '../PhoneBrowserFocus';

describe('phoneBrowserStreamEnabled', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is on unless WMUX_PHONE_BROWSER_STREAM is 0', () => {
    vi.stubEnv('WMUX_PHONE_BROWSER_STREAM', undefined);
    expect(phoneBrowserStreamEnabled()).toBe(true);
    vi.stubEnv('WMUX_PHONE_BROWSER_STREAM', '1');
    expect(phoneBrowserStreamEnabled()).toBe(true);
    vi.stubEnv('WMUX_PHONE_BROWSER_STREAM', '0');
    expect(phoneBrowserStreamEnabled()).toBe(false);
  });
});

/**
 * Main's side of the phone browser stream over a fake Chrome session, with
 * fake timers: what is pushed to the daemon and when, when Chrome's frames are
 * acked, the geometry and URL each frame carries, and how a stream stops.
 */

/** A JPEG header Chrome could have sent: `w`×`h`, padded to about `kib` KiB of base64. */
function jpeg(w: number, h: number, kib = 1): string {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, Math.floor((kib * 1024 * 3) / 4) - head.length), 1)]).toString('base64');
}

const META = { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1200, deviceHeight: 700, scrollOffsetX: 0, scrollOffsetY: 40 };

class FakeSession implements ChromeStreamSession {
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private handlers = new Map<string, Array<(p: Record<string, unknown>) => void>>();
  private closers: Array<() => void> = [];
  closed = false;
  detached = false;
  url = 'https://a.example.com/start';
  zoom = 1;
  visibility = 'visible';
  layout = { clientWidth: 1183, clientHeight: 683, pageX: 0, pageY: 40, scale: 1 };
  /** captureScreenshot never answers while true. */
  captureHangs = false;
  /** The page's focus as the focus watcher reads it; null: no isolated world (the watcher does not start). */
  focus: Record<string, unknown> | null = null;
  /** A command that waits for its gate before it answers. */
  gates = new Map<string, Promise<void>>();
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ChromePageSessionError('gone', 'ended');
    this.sent.push({ method, params });
    const gate = this.gates.get(method);
    if (gate) await gate;
    switch (method) {
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: this.url } } };
      case 'Page.getLayoutMetrics': return { cssVisualViewport: { ...this.layout, zoom: this.zoom } };
      case 'Page.createIsolatedWorld': return this.focus ? { executionContextId: 21 } : {};
      case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'focus-script' };
      case 'Runtime.evaluate': return params?.expression === WATCH_FOCUS_EXPRESSION ? { result: { value: [this.focus, true] } } : { result: { value: this.visibility } };
      case 'Page.captureScreenshot': return this.captureHangs ? new Promise(() => undefined) : { data: jpeg(600, 340) };
      default: return {};
    }
  }
  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }
  onClosed(listener: () => void): void { this.closers.push(listener); }
  async detach(): Promise<void> { this.detached = true; this.close(); }
  emit(method: string, params: Record<string, unknown>): void { for (const h of this.handlers.get(method) ?? []) h(params); }
  frame(n: number, meta: Record<string, unknown> = {}, data = jpeg(600, 350)): void {
    this.emit('Page.screencastFrame', { data, metadata: { ...META, ...meta }, sessionId: n });
  }
  /** Chrome detached it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.closers.splice(0)) c();
  }
  acks(): number[] { return this.sent.filter((s) => s.method === 'Page.screencastFrameAck').map((s) => s.params?.sessionId as number); }
  count(method: string): number { return this.sent.filter((s) => s.method === method).length; }
  /** The focus watcher's binding name, once it added it. */
  binding(): string | undefined { return this.sent.find((s) => s.method === 'Runtime.addBinding')?.params?.name as string | undefined; }
  nudge(): void { this.emit('Runtime.bindingCalled', { name: this.binding(), payload: '' }); }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('phone browser stream (main)', () => {
  let sessions: FakeSession[];
  let pushes: Array<Record<string, unknown>>;
  let reply: (params: Record<string, unknown>) => Promise<unknown>;
  let owned: boolean;
  let streams: PhoneBrowserStreams;
  let tabURL: string;
  /** What each new session's page has focused (null: the watcher cannot start there). */
  let pageFocus: Record<string, unknown> | null;
  /** Gates each new session's commands by method. */
  let gates: Map<string, Promise<void>>;
  /** Each new session's visual viewport and browser zoom; null: the fake's own. */
  let pageLayout: FakeSession['layout'] | null;
  let pageZoom: number;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    sessions = [];
    pushes = [];
    owned = true;
    tabURL = 'https://a.example.com/start';
    pageFocus = null;
    gates = new Map();
    pageLayout = null;
    pageZoom = 1;
    reply = async () => ({ ok: true, known: true });
    const deps: PhoneBrowserStreamDeps = {
      push: (params) => { pushes.push(params); return reply(params); },
      backend: () => 'chrome',
      chrome: {
        tabs: async () => ['chrome-a', 'chrome-b', 'chrome-c', 'chrome-d'].map((surfaceId) => ({ surfaceId, url: tabURL })),
        streamSession: async () => {
          const s = new FakeSession();
          s.focus = pageFocus;
          s.gates = gates;
          s.zoom = pageZoom;
          if (pageLayout) s.layout = pageLayout;
          sessions.push(s);
          return s;
        },
        owns: () => owned,
      },
      captureMs: 5_000,
    };
    streams = createPhoneBrowserStreams(deps);
  });
  afterEach(() => { streams.stopAll(); vi.useRealTimers(); });

  const start = async (extra: Record<string, unknown> = {}, surfaceId = 'chrome-a') =>
    streams.handle('browser.streamStart', { workspaceId: 'ws-1', surfaceId, streamId: `st-${surfaceId}`, maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 10, ...extra });
  const frames = () => pushes.filter((p) => p.kind === 'frame');
  const kinds = () => pushes.filter((p) => p.kind !== 'ping').map((p) => p.kind === 'state' ? `state:${String(p.state)}` : String(p.kind));

  it('starts a screencast on a session of its own and answers its size', async () => {
    expect(await start()).toEqual({ backend: 'chrome', maxWidth: 1280, maxHeight: 1280, quality: 60 });
    const s = sessions[0];
    expect(s.sent.map((x) => x.method).slice(0, 4)).toEqual(['Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.startScreencast']);
    expect(s.sent[3].params).toEqual({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
    expect(streams.tab('chrome-a', 'ws-1')?.url).toBe('https://a.example.com/start');
  });

  it('refuses what it cannot stream, in the preview\'s codes', async () => {
    expect(await start({}, 'surf-builtin')).toEqual({ error: 'browser-action-unsupported' });
    expect(await start({}, 'chrome-unknown')).toEqual({ error: 'browser-tab-gone' });
    tabURL = 'file:///etc/hosts';
    await expect(start()).rejects.toThrow();
    expect(sessions).toHaveLength(0);
  });

  it('pushes each frame with its URL and geometry, and acks it only once the daemon answered', async () => {
    let answer!: () => void;
    reply = () => new Promise((resolve) => { answer = () => resolve({ ok: true, known: true }); });
    await start();
    const s = sessions[0];
    s.frame(1);
    await flush();
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({
      streamId: 'st-chrome-a', kind: 'frame', imageWidth: 600, imageHeight: 350, pageURL: 'https://a.example.com/start',
      geometry: { width: 1200, height: 700, scrollX: 0, scrollY: 40 },
    });
    expect(frames()[0].geometry).not.toHaveProperty('scale');
    expect(s.acks()).toEqual([]);
    answer();
    await flush();
    expect(s.acks()).toEqual([1]);
  });

  it('keeps only the newest frame while a push is in flight; the replaced one is acked only when the newest goes out', async () => {
    let answer!: () => void;
    reply = (p) => p.kind === 'frame' ? new Promise((resolve) => { answer = () => resolve({ ok: true, known: true }); }) : Promise.resolve({ known: true });
    await start({ maxFps: 15 });
    const s = sessions[0];
    s.frame(1);
    await flush();
    s.frame(2);
    s.frame(3);
    await flush();
    // Two frames out unacked: Chrome captures no more until one is.
    expect(s.acks()).toEqual([]);
    answer();
    await vi.advanceTimersByTimeAsync(100);
    expect(frames()).toHaveLength(2);
    expect(frames()[1]).toMatchObject({ kind: 'frame' });
    expect(s.acks()).toEqual([1, 2]);
    answer();
    await flush();
    expect(s.acks()).toEqual([1, 2, 3]);
  });

  it('a frame waiting for its slot holds the acks of those it replaced, lets them go once just before the slot, and a stop acks them all', async () => {
    await start({ maxFps: 1 });
    const s = sessions[0];
    s.frame(1);
    await flush();
    expect(s.acks()).toEqual([1]);
    for (const n of [2, 3, 4]) s.frame(n);
    await vi.advanceTimersByTimeAsync(500);
    expect(frames()).toHaveLength(1);
    expect(s.acks()).toEqual([1]);
    // 100 ms before the slot: the held acks go, so the browser may paint a fresher frame.
    await vi.advanceTimersByTimeAsync(400);
    expect(frames()).toHaveLength(1);
    expect(s.acks()).toEqual([1, 2, 3]);
    // It does, and that one holds 4's ack until it is sent: no second early release.
    s.frame(5);
    await flush();
    expect(s.acks()).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames()).toHaveLength(2);
    expect(s.acks()).toEqual([1, 2, 3, 4, 5]);
    s.frame(6);
    s.frame(7);
    await flush();
    expect(s.acks()).toEqual([1, 2, 3, 4, 5]);
    await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'st-chrome-a' });
    expect(s.acks()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('paces frames to the stream\'s maxFps, and a streamUpdate raises it', async () => {
    await start({ maxFps: 2 });
    const s = sessions[0];
    for (let i = 1; i <= 10; i++) {
      s.frame(i);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(frames().length).toBeLessThanOrEqual(3);
    await streams.handle('browser.streamUpdate', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'st-chrome-a', maxFps: 10 });
    const before = frames().length;
    for (let i = 11; i <= 20; i++) {
      s.frame(i);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(frames().length - before).toBeGreaterThanOrEqual(8);
  });

  it('geometry: scale under pinch zoom; none with a top offset, under browser zoom, or mid-navigation', async () => {
    await start({ maxFps: 15 });
    const s = sessions[0];
    const next = async (n: number, meta: Record<string, unknown> = {}) => { s.frame(n, meta); await vi.advanceTimersByTimeAsync(100); return frames().at(-1)!; };
    expect((await next(1, { pageScaleFactor: 0.4, deviceWidth: 390, deviceHeight: 844 })).geometry).toEqual({ width: 390, height: 844, scrollX: 0, scrollY: 40, scale: 0.4 });
    expect(streams.tab('chrome-a', 'ws-1')?.geometry).toEqual({ width: 390, height: 844, scrollX: 0, scrollY: 40, scale: 0.4 });
    expect((await next(2, { offsetTop: 56 }))).not.toHaveProperty('geometry');
    expect(streams.tab('chrome-a', 'ws-1')?.geometry).toBeNull();
    s.zoom = 1.25;
    await vi.advanceTimersByTimeAsync(2_000);
    s.frame(3);
    await vi.advanceTimersByTimeAsync(600);
    s.frame(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames().at(-1)).not.toHaveProperty('geometry');
    expect(frames().at(-1)?.pageURL).toBe('https://a.example.com/start');
    s.zoom = 1;
    s.emit('Page.frameStartedNavigating', { frameId: 'main', url: 'https://b.example.com/', navigationType: 'differentDocument' });
    const mid = await next(5);
    expect(mid).not.toHaveProperty('geometry');
    expect(mid).not.toHaveProperty('pageURL');
    s.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://b.example.com/' } });
    await vi.advanceTimersByTimeAsync(10);
    expect((await next(6)).pageURL).toBe('https://b.example.com/');
  });

  it('tracks the current document\'s URLs and pushes url events, coalesced to ten a second', async () => {
    await start();
    const s = sessions[0];
    for (const q of ['a', 'ab', 'abc', 'abcd']) s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: `https://a.example.com/search?q=${q}` });
    await flush();
    expect(pushes.filter((p) => p.kind === 'url').map((p) => p.pageURL)).toEqual(['https://a.example.com/search?q=a']);
    await vi.advanceTimersByTimeAsync(100);
    expect(pushes.filter((p) => p.kind === 'url').map((p) => p.pageURL)).toEqual(['https://a.example.com/search?q=a', 'https://a.example.com/search?q=abcd']);
    const view = streams.tab('chrome-a', 'ws-1')!;
    expect(view.url).toBe('https://a.example.com/search?q=abcd');
    expect([...view.docUrls]).toEqual(['https://a.example.com/start', ...['a', 'ab', 'abc', 'abcd'].map((q) => `https://a.example.com/search?q=${q}`)]);
    // A frame on another document starts the set again; an iframe's commit is not the page's.
    s.emit('Page.frameNavigated', { frame: { id: 'sub', parentId: 'main', url: 'https://ads.example.com/' } });
    s.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://b.example.com/x', urlFragment: '#top' } });
    expect([...view.docUrls]).toEqual(['https://b.example.com/x#top']);
    for (let i = 0; i < 80; i++) s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: `https://b.example.com/x?i=${i}` });
    expect(view.docUrls.size).toBe(64);
    expect(view.docUrls.has('https://b.example.com/x?i=79')).toBe(true);
  });

  it('a 300 KiB pushState URL: frames and the url event go without it, every push inside the line limit', async () => {
    await start({ maxFps: 15 });
    const s = sessions[0];
    const long = `https://a.example.com/app?state=${'x'.repeat(300 * 1024)}`;
    s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: long });
    s.frame(1);
    await vi.advanceTimersByTimeAsync(200);
    const url = pushes.find((p) => p.kind === 'url')!;
    expect(url).toEqual({ streamId: 'st-chrome-a', kind: 'url' });
    expect(frames()[0]).not.toHaveProperty('pageURL');
    expect(frames()[0]).not.toHaveProperty('geometry');
    for (const p of pushes) expect(JSON.stringify(p).length).toBeLessThan(STREAM_LINE_LIMIT);
    const view = streams.tab('chrome-a', 'ws-1')!;
    expect(view.url).toBe(long);
    expect(view.docUrls.has(long)).toBe(false);
  });

  it('a page that is not http(s) is a url event without its URL and sends no frames; the stream goes on', async () => {
    await start();
    const s = sessions[0];
    s.frame(1);
    await flush();
    s.emit('Page.frameNavigated', { frame: { id: 'main', url: 'chrome-error://chromewebdata/' } });
    await vi.advanceTimersByTimeAsync(100);
    expect(pushes.filter((p) => p.kind === 'url')).toEqual([{ streamId: 'st-chrome-a', kind: 'url' }]);
    const view = streams.tab('chrome-a', 'ws-1')!;
    expect(view.url).toBeNull();
    expect(view.docUrls.size).toBe(0);
    s.frame(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(frames()).toHaveLength(1);
    expect(s.acks()).toContain(2);
    expect(s.count('Page.stopScreencast')).toBe(0);
    s.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://b.example.com/' } });
    s.frame(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(pushes.filter((p) => p.kind === 'url').at(-1)).toMatchObject({ pageURL: 'https://b.example.com/' });
    expect(frames().at(-1)).toMatchObject({ pageURL: 'https://b.example.com/' });
  });

  it('known:false from the daemon stops the screencast; a refused push is a dropped frame', async () => {
    reply = async () => { throw new Error('rate limited (stream)'); };
    await start({ maxFps: 15 });
    const s = sessions[0];
    s.frame(1);
    await flush();
    expect(s.acks()).toEqual([1]);
    expect(streams.tab('chrome-a', 'ws-1')).not.toBeNull();
    reply = async () => ({ ok: false, known: false });
    await vi.advanceTimersByTimeAsync(100);
    s.frame(2);
    await flush();
    expect(streams.tab('chrome-a', 'ws-1')).toBeNull();
    expect(s.count('Page.stopScreencast')).toBe(1);
    await flush();
    expect(s.detached).toBe(true);
    const count = pushes.length;
    s.frame(3);
    await flush();
    expect(pushes).toHaveLength(count);
  });

  it('a refused url push goes again, before the frame after it, unless a newer one waits; five tries at most', async () => {
    await start();
    const s = sessions[0];
    let refuse = 1;
    reply = async (params) => {
      if (params.kind === 'url' && refuse > 0) { refuse -= 1; throw new Error('rate limited (stream)'); }
      return { ok: true, known: true };
    };
    s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://a.example.com/start#one' });
    s.frame(1);
    await vi.advanceTimersByTimeAsync(300);
    const sent = () => pushes.filter((p) => p.kind === 'url' || p.kind === 'frame').map((p) => p.kind === 'url' ? `url:${String(p.pageURL)}` : 'frame');
    expect(sent()).toEqual(['url:https://a.example.com/start#one', 'url:https://a.example.com/start#one', 'frame']);
    // A newer url waiting: the refused one is not sent again.
    pushes = [];
    refuse = 1;
    s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://a.example.com/start#two' });
    s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://a.example.com/start#three' });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toEqual(['url:https://a.example.com/start#two', 'url:https://a.example.com/start#three']);
    // Refused every time: one send and five more, then it is given up.
    pushes = [];
    refuse = Infinity;
    s.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://a.example.com/start#four' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent()).toHaveLength(6);
  });

  it('pings every 15 s; known:false on a ping stops it too', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pushes.filter((p) => p.kind === 'ping')).toHaveLength(1);
    reply = async () => ({ ok: false, known: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(streams.tab('chrome-a', 'ws-1')).toBeNull();
  });

  it('a frame too large for the pipe is skipped and the screencast restarts smaller, down to 320 px and quality 30', async () => {
    await start({ maxWidth: 400, maxHeight: 400, quality: 50 });
    const s = sessions[0];
    s.frame(1, {}, jpeg(400, 400, 720));
    await flush();
    expect(frames()).toEqual([]);
    expect(s.acks()).toEqual([1]);
    const starts = () => s.sent.filter((x) => x.method === 'Page.startScreencast').map((x) => x.params);
    expect(starts().at(-1)).toMatchObject({ maxWidth: 320, maxHeight: 320, quality: 35 });
    s.frame(2, {}, jpeg(320, 320, 720));
    await flush();
    expect(starts().at(-1)).toMatchObject({ maxWidth: 320, maxHeight: 320, quality: 30 });
    s.frame(3, {}, jpeg(320, 320, 720));
    await flush();
    expect(starts()).toHaveLength(3);
  });

  it('a still page gets a captured first frame after a second; a capture past its budget is hidden', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessions[0].count('Page.captureScreenshot')).toBe(1);
    expect(frames()[0]).toMatchObject({ imageWidth: 600, imageHeight: 340, pageURL: 'https://a.example.com/start', geometry: { width: 1183, height: 683, scrollX: 0, scrollY: 40 } });
    await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'st-chrome-a' });
    pushes = [];
    await start({}, 'chrome-b');
    sessions[1].captureHangs = true;
    await vi.advanceTimersByTimeAsync(1_000 + 5_000);
    expect(kinds()).toEqual(['state:hidden']);
    sessions[1].frame(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(kinds()).toEqual(['state:hidden', 'state:live', 'frame']);
  });

  it('hidden: Chrome reports the tab not visible for five quiet seconds, or a probe reads it hidden; never silence alone', async () => {
    await start();
    const s = sessions[0];
    s.frame(1);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    // A still page in view: probed, never called hidden.
    expect(s.count('Runtime.evaluate')).toBeGreaterThanOrEqual(2);
    expect(kinds()).toEqual(['frame']);
    s.emit('Page.screencastVisibilityChanged', { visible: false });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(kinds()).toEqual(['frame', 'state:hidden']);
    s.emit('Page.screencastVisibilityChanged', { visible: true });
    s.frame(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(kinds()).toEqual(['frame', 'state:hidden', 'state:live', 'frame']);
    s.visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kinds().at(-1)).toBe('state:hidden');
  });

  it('re-attaches when Chrome swaps the page, three times a minute; one more, or a tab no longer this workspace\'s, ends it', async () => {
    await start();
    // The old page had started a navigation; the swapped-in page is committed.
    sessions[0].emit('Page.frameStartedLoading', { frameId: 'main' });
    sessions[0].close();
    expect(streams.tab('chrome-a', 'ws-1')!.url).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].count('Page.startScreencast')).toBe(1);
    expect(streams.tab('chrome-a', 'ws-1')!.url).toBe('https://a.example.com/start');
    sessions[1].frame(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames().at(-1)).toMatchObject({ pageURL: 'https://a.example.com/start', geometry: { width: 1200 } });
    for (const n of [1, 2]) {
      sessions[n].close();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sessions).toHaveLength(4);
    sessions[3].close();
    await flush();
    expect(pushes.at(-1)).toEqual({ streamId: 'st-chrome-a', kind: 'end', error: 'browser-tab-gone' });
    pushes = [];
    await start({}, 'chrome-b');
    owned = false;
    sessions[4].close();
    await vi.advanceTimersByTimeAsync(500);
    expect(pushes.at(-1)).toEqual({ streamId: 'st-chrome-b', kind: 'end', error: 'browser-tab-gone' });
    expect(sessions).toHaveLength(5);
  });

  describe('viewport=mobile', () => {
    const OVERRIDE = { width: 390, height: 683, deviceScaleFactor: 2, mobile: true };
    const emulation = (s: FakeSession) => s.sent.filter((x) => x.method.startsWith('Emulation.')).map((x) => [x.method, x.params]);
    const update = (mobile: boolean) => streams.handle('browser.streamUpdate', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'st-chrome-a', mobile });

    it('emulates a phone on the stream\'s own session at the real size or less, with touch, before the screencast starts', async () => {
      await start({ mobile: true });
      const s = sessions[0];
      // The real tab is 1183×683 CSS px at zoom 1: as wide as a phone, as tall as the tab.
      expect(emulation(s)).toEqual([
        ['Emulation.setDeviceMetricsOverride', OVERRIDE],
        ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
      ]);
      const methods = s.sent.map((x) => x.method);
      expect(methods.indexOf('Emulation.setDeviceMetricsOverride')).toBeLessThan(methods.indexOf('Page.startScreencast'));
    });

    it('turned off and on by the daemon; a stop clears it by detaching, with no command of its own', async () => {
      await start();
      const s = sessions[0];
      expect(emulation(s)).toEqual([]);
      await update(true);
      await flush();
      expect(emulation(s)).toHaveLength(2);
      await update(false);
      await flush();
      expect(emulation(s).slice(2)).toEqual([
        ['Emulation.clearDeviceMetricsOverride', undefined],
        ['Emulation.setTouchEmulationEnabled', { enabled: false }],
      ]);
      // Asked again while already off: nothing more.
      await update(false);
      await update(true);
      await flush();
      expect(emulation(s)).toHaveLength(6);
      streams.stopAll();
      await flush();
      expect(s.detached).toBe(true);
      expect(emulation(s)).toHaveLength(6);
    });

    it('a page swap applies it again on the new session before its screencast', async () => {
      await start({ mobile: true });
      sessions[0].close();
      await vi.advanceTimersByTimeAsync(500);
      expect(sessions).toHaveLength(2);
      expect(emulation(sessions[1])).toEqual([
        ['Emulation.setDeviceMetricsOverride', OVERRIDE],
        ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
      ]);
      const methods = sessions[1].sent.map((x) => x.method);
      expect(methods.indexOf('Emulation.setDeviceMetricsOverride')).toBeLessThan(methods.indexOf('Page.startScreencast'));
    });

    it('a narrower tab, or one at a browser zoom, is emulated at its own size in device-independent pixels', async () => {
      pageLayout = { clientWidth: 300, clientHeight: 500, pageX: 0, pageY: 0, scale: 1 };
      pageZoom = 1.25;
      await start({ mobile: true });
      expect(emulation(sessions[0])[0]).toEqual(['Emulation.setDeviceMetricsOverride', { width: 375, height: 625, deviceScaleFactor: 2, mobile: true }]);
    });
  });

  describe('focus (contract v1.6)', () => {
    const focus = () => pushes.filter((p) => p.kind === 'focus').map((p) => p.focus);

    it('watched after attach on the stream\'s session, never with Runtime.enable; each change pushed, paced like url events', async () => {
      pageFocus = { editable: false };
      await start();
      await flush();
      const s = sessions[0];
      expect(pushes.find((p) => p.kind === 'focus')).toEqual({ streamId: 'st-chrome-a', kind: 'focus', focus: { editable: false } });
      expect(s.sent.map((x) => x.method)).not.toContain('Runtime.enable');
      // Started once the screencast runs.
      expect(s.sent.findIndex((x) => x.method === 'Page.addScriptToEvaluateOnNewDocument')).toBeGreaterThan(s.sent.findIndex((x) => x.method === 'Page.startScreencast'));
      expect(s.sent.find((x) => x.method === 'Runtime.addBinding')?.params).toEqual({ name: s.binding(), executionContextId: 21 });
      s.focus = { editable: true, kind: 'text' };
      s.nudge();
      await vi.advanceTimersByTimeAsync(100);
      expect(focus().at(-1)).toEqual({ editable: true, kind: 'text' });
      // Two changes inside 100 ms: one push waits its turn, and the last state always goes.
      s.focus = { editable: true, kind: 'password' };
      s.nudge();
      await flush();
      s.focus = { editable: true, kind: 'email' };
      s.nudge();
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(focus().at(-1)).toEqual({ editable: true, kind: 'email' });
      // A cross-document commit resets it.
      s.focus = { editable: false };
      s.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://a.example.com/next' } });
      await vi.advanceTimersByTimeAsync(100);
      expect(focus().at(-1)).toEqual({ editable: false });
      expect(kinds().filter((k) => k === 'url' || k === 'focus').slice(-2)).toEqual(['url', 'focus']);
    });

    it('stops with the stream: its binding is taken back, and nothing is pushed after', async () => {
      pageFocus = { editable: false };
      await start();
      await flush();
      const s = sessions[0];
      await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'st-chrome-a' });
      await vi.advanceTimersByTimeAsync(50);
      expect(s.count('Runtime.removeBinding')).toBe(1);
      // The detectors' teardown runs on the stream's session, before the screencast stops and the session goes.
      const order = s.sent.map((x) => x.method);
      expect(order.lastIndexOf('Runtime.removeBinding')).toBeLessThan(order.lastIndexOf('Page.stopScreencast'));
      expect(s.detached).toBe(true);
      const pushed = pushes.length;
      s.focus = { editable: true, kind: 'text' };
      s.nudge();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pushes.length).toBe(pushed);
    });

    it('a stop while attaching, or while the watcher installs, keeps no watcher running', async () => {
      pageFocus = { editable: false };
      let open!: () => void;
      gates.set('Page.startScreencast', new Promise<void>((resolve) => { open = resolve; }));
      const started = start();
      await flush();
      streams.stopAll();
      open();
      await started.catch(() => undefined);
      await flush();
      expect(sessions[0].count('Page.addScriptToEvaluateOnNewDocument')).toBe(0);
      // Stopped while the watcher installs: what it installed goes, nothing is pushed.
      gates = new Map();
      let install!: () => void;
      gates.set('Page.addScriptToEvaluateOnNewDocument', new Promise<void>((resolve) => { install = resolve; }));
      await start({}, 'chrome-b');
      await flush();
      expect(sessions[1].count('Page.addScriptToEvaluateOnNewDocument')).toBe(1);
      await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'chrome-b', streamId: 'st-chrome-b' });
      install();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pushes.filter((p) => p.kind === 'focus')).toEqual([]);
    });

    it('a page swap drops the old watcher and the re-attach starts one on the new session', async () => {
      pageFocus = { editable: false };
      await start();
      await flush();
      const old = sessions[0];
      old.close();
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      const fresh = sessions[1];
      expect(fresh.count('Runtime.addBinding')).toBe(1);
      fresh.focus = { editable: true, kind: 'url' };
      fresh.nudge();
      await vi.advanceTimersByTimeAsync(100);
      expect(focus().at(-1)).toEqual({ editable: true, kind: 'url' });
      // The old session's watcher is gone: its events reach nothing.
      const pushed = pushes.length;
      old.focus = { editable: true, kind: 'tel' };
      old.emit('Runtime.bindingCalled', { name: old.binding(), payload: '' });
      await vi.advanceTimersByTimeAsync(200);
      expect(pushes.slice(pushed).filter((p) => p.kind === 'focus')).toEqual([]);
    });

    it('a page the watcher cannot read still streams, with no focus events', async () => {
      await start();
      sessions[0].frame(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(frames()).toHaveLength(1);
      expect(pushes.filter((p) => p.kind === 'focus')).toEqual([]);
    });
  });

  it('a frame from a tab no longer this workspace\'s ends the stream', async () => {
    await start();
    owned = false;
    sessions[0].frame(1);
    await flush();
    expect(pushes.at(-1)).toEqual({ streamId: 'st-chrome-a', kind: 'end', error: 'browser-tab-gone' });
  });

  it('stop answers only its own stream id; stopAll stops and detaches every screencast', async () => {
    await start();
    await start({}, 'chrome-b');
    expect(await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'other' })).toEqual({ applied: false });
    expect(streams.tab('chrome-a', 'ws-1')).not.toBeNull();
    streams.stopAll();
    await flush();
    expect(sessions.every((s) => s.count('Page.stopScreencast') === 1 && s.detached)).toBe(true);
    expect(streams.tab('chrome-b', 'ws-1')).toBeNull();
  });

  it('holds all tabs together to 8 MiB of frames a second, past a quarter-second burst', async () => {
    await start({ maxFps: 15 }, 'chrome-a');
    await start({ maxFps: 15 }, 'chrome-b');
    for (let i = 1; i <= 45; i++) {
      for (const s of sessions) s.frame(i, {}, jpeg(1280, 720, 600));
      await vi.advanceTimersByTimeAsync(66);
    }
    // About three seconds: three seconds' worth and the burst at most, and not far below it.
    const bytes = frames().reduce((n, p) => n + String(p.data).length, 0);
    expect(bytes).toBeLessThanOrEqual(3 * 8 * 1024 * 1024 + 2 * 1024 * 1024);
    expect(bytes).toBeGreaterThanOrEqual(2.5 * 8 * 1024 * 1024);
  });

  it('over budget, each tab\'s frames come evenly spaced, not a second\'s worth in a burst and then nothing', async () => {
    const sent: Array<{ streamId: unknown; at: number }> = [];
    reply = async (p) => { if (p.kind === 'frame') sent.push({ streamId: p.streamId, at: Date.now() }); return { ok: true, known: true }; };
    await start({ maxFps: 15 }, 'chrome-a');
    await start({ maxFps: 15 }, 'chrome-b');
    const startedAt = Date.now();
    for (let i = 1; i <= 60; i++) {
      for (const s of sessions) s.frame(i, {}, jpeg(1280, 720, 600));
      await vi.advanceTimersByTimeAsync(66);
    }
    for (const streamId of ['st-chrome-a', 'st-chrome-b']) {
      // Past the first second's burst: the steady state.
      const times = sent.filter((s) => s.streamId === streamId && s.at - startedAt >= 1_000).map((s) => s.at);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      // 8 MiB/s of ~600 KiB frames over two tabs: about 150 ms apart each.
      expect(gaps.length).toBeGreaterThanOrEqual(15);
      expect(Math.max(...gaps)).toBeLessThan(300);
    }
  });

  it('a tab of large frames is not starved by tabs of smaller ones: a refused tab is served before anyone after it', async () => {
    const sent: Array<{ streamId: unknown; at: number }> = [];
    reply = async (p) => { if (p.kind === 'frame') sent.push({ streamId: p.streamId, at: Date.now() }); return { ok: true, known: true }; };
    for (const surfaceId of ['chrome-a', 'chrome-b', 'chrome-c', 'chrome-d']) await start({ maxFps: 15 }, surfaceId);
    const startedAt = Date.now();
    // Three tabs of ~300 KiB frames ask for about 13 MiB/s between them, past
    // the 8 MiB/s budget; the fourth paints ~690 KiB frames.
    for (let i = 1; i <= 60; i++) {
      sessions[0].frame(i, {}, jpeg(1280, 720, 690));
      for (const s of sessions.slice(1)) s.frame(i, {}, jpeg(1280, 720, 300));
      await vi.advanceTimersByTimeAsync(66);
    }
    const large = sent.filter((s) => s.streamId === 'st-chrome-a' && s.at - startedAt >= 1_000).map((s) => s.at);
    const gaps = large.slice(1).map((t, i) => t - large[i]);
    // In turn with the others: about one round of all four tabs per ~200 ms.
    expect(large.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...gaps)).toBeLessThan(400);
    // Each small tab keeps its turn too.
    for (const streamId of ['st-chrome-b', 'st-chrome-c', 'st-chrome-d']) {
      expect(sent.filter((s) => s.streamId === streamId && s.at - startedAt >= 1_000).length).toBeGreaterThanOrEqual(10);
    }
  });

  it('a tab that stops while it waits in line for the budget leaves the line: the tab behind it goes on', async () => {
    const sent: Array<{ streamId: unknown; at: number }> = [];
    reply = async (p) => { if (p.kind === 'frame') sent.push({ streamId: p.streamId, at: Date.now() }); return { ok: true, known: true }; };
    await start({ maxFps: 15 }, 'chrome-a');
    await start({ maxFps: 15 }, 'chrome-b');
    const of = (streamId: string) => sent.filter((s) => s.streamId === streamId).length;
    // Large frames on A until one is refused: past its own frame interval, it waits for bytes.
    let refused = false;
    for (let i = 1; i <= 40 && !refused; i++) {
      const before = of('st-chrome-a');
      sessions[0].frame(i, {}, jpeg(1280, 720, 690));
      await vi.advanceTimersByTimeAsync(1);
      refused = of('st-chrome-a') === before;
      sessions[1].frame(i, {}, jpeg(1280, 720, 300));
      if (!refused) await vi.advanceTimersByTimeAsync(67);
    }
    expect(refused).toBe(true);
    // B is now in line behind A; A stops.
    await vi.advanceTimersByTimeAsync(1);
    await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'chrome-a', streamId: 'st-chrome-a' });
    const before = of('st-chrome-b');
    for (let i = 100; i < 115; i++) {
      sessions[1].frame(i, {}, jpeg(1280, 720, 300));
      await vi.advanceTimersByTimeAsync(67);
    }
    expect(of('st-chrome-b') - before).toBeGreaterThanOrEqual(10);
  });
});
