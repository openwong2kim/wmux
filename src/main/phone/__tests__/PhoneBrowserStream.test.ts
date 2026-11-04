import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChromeStreamSession } from '../../browser-session/ChromeLauncher';
import { ChromePageSessionError } from '../../browser-session/ChromeLauncher';
import { createPhoneBrowserStreams, STREAM_LINE_LIMIT, type PhoneBrowserStreamDeps, type PhoneBrowserStreams } from '../PhoneBrowserStream';

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
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ChromePageSessionError('gone', 'ended');
    this.sent.push({ method, params });
    switch (method) {
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: this.url } } };
      case 'Page.getLayoutMetrics': return { cssVisualViewport: { ...this.layout, zoom: this.zoom } };
      case 'Runtime.evaluate': return { result: { value: this.visibility } };
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
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('phone browser stream (main)', () => {
  let sessions: FakeSession[];
  let pushes: Array<Record<string, unknown>>;
  let reply: (params: Record<string, unknown>) => Promise<unknown>;
  let owned: boolean;
  let streams: PhoneBrowserStreams;
  let tabURL: string;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    sessions = [];
    pushes = [];
    owned = true;
    tabURL = 'https://a.example.com/start';
    reply = async () => ({ ok: true, known: true });
    const deps: PhoneBrowserStreamDeps = {
      push: (params) => { pushes.push(params); return reply(params); },
      backend: () => 'chrome',
      chrome: {
        tabs: async () => [{ surfaceId: 'chrome-a', url: tabURL }, { surfaceId: 'chrome-b', url: tabURL }],
        streamSession: async () => { const s = new FakeSession(); sessions.push(s); return s; },
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

  it('keeps only the newest frame while a push is in flight; the replaced one is acked at once', async () => {
    let answer!: () => void;
    reply = (p) => p.kind === 'frame' ? new Promise((resolve) => { answer = () => resolve({ ok: true, known: true }); }) : Promise.resolve({ known: true });
    await start({ maxFps: 15 });
    const s = sessions[0];
    s.frame(1);
    await flush();
    s.frame(2);
    s.frame(3);
    await flush();
    expect(s.acks()).toEqual([2]);
    answer();
    await vi.advanceTimersByTimeAsync(100);
    expect(frames()).toHaveLength(2);
    expect(s.acks()).toEqual([2, 1]);
    answer();
    await flush();
    expect(s.acks()).toEqual([2, 1, 3]);
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

  it('a page that is not http(s) ends the stream with browser-preview-unavailable', async () => {
    await start();
    const s = sessions[0];
    s.emit('Page.frameNavigated', { frame: { id: 'main', url: 'chrome-error://chromewebdata/' } });
    await flush();
    expect(pushes.at(-1)).toEqual({ streamId: 'st-chrome-a', kind: 'end', error: 'browser-preview-unavailable' });
    expect(s.count('Page.stopScreencast')).toBe(1);
    expect(streams.tab('chrome-a', 'ws-1')).toBeNull();
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

  it('re-attaches once when Chrome swaps the page; a second loss, or a tab no longer this workspace\'s, ends it', async () => {
    await start();
    sessions[0].close();
    await vi.advanceTimersByTimeAsync(500);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].count('Page.startScreencast')).toBe(1);
    sessions[1].close();
    await flush();
    expect(pushes.at(-1)).toEqual({ streamId: 'st-chrome-a', kind: 'end', error: 'browser-tab-gone' });
    pushes = [];
    await start({}, 'chrome-b');
    owned = false;
    sessions[2].close();
    await vi.advanceTimersByTimeAsync(500);
    expect(pushes.at(-1)).toEqual({ streamId: 'st-chrome-b', kind: 'end', error: 'browser-tab-gone' });
    expect(sessions).toHaveLength(3);
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

  it('holds all tabs together to 8 MiB of frames a second', async () => {
    await start({ maxFps: 15 }, 'chrome-a');
    await start({ maxFps: 15 }, 'chrome-b');
    for (let i = 1; i <= 15; i++) {
      for (const s of sessions) s.frame(i, {}, jpeg(1280, 720, 600));
      await vi.advanceTimersByTimeAsync(66);
    }
    const bytes = frames().reduce((n, p) => n + String(p.data).length, 0);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(frames().length).toBeGreaterThanOrEqual(12);
  });
});
