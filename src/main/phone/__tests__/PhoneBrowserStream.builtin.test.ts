import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { CdpTargetInfo } from '../../browser-session/WebviewCdpManager';
import { createPhoneBrowserStreams, type PhoneBrowserStreamDeps, type PhoneBrowserStreams } from '../PhoneBrowserStream';
import { WATCH_FOCUS_EXPRESSION } from '../PhoneBrowserFocus';

/**
 * Main's side of the phone browser stream on a builtin pane, over a fake
 * guest and its debugger, with fake timers: the screencast on the debugger
 * WebviewCdpManager attached, the URL from the guest's own navigation events,
 * hidden and live from the renderer's visibility reports, and how the stream
 * ends when the pane goes.
 */

/** A JPEG header the guest could have painted: `w`×`h`. */
function jpeg(w: number, h: number): string {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([head, Buffer.alloc(1024, 1)]).toString('base64');
}

/** What the spike read off a 900×668 webview at zoom 1, scrolled to a fractional offset. */
const META = { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 900, deviceHeight: 668, scrollOffsetX: 0, scrollOffsetY: 123.5 };

class FakeDebugger extends EventEmitter {
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  attached = true;
  layout = { clientWidth: 900, clientHeight: 668, pageX: 0, pageY: 123.5, scale: 1, zoom: 1 };
  /** captureScreenshot never answers while true. */
  captureHangs = false;
  /** The page's focus as the focus watcher reads it; null: the page has no frame tree to watch. */
  focus: Record<string, unknown> | null = null;
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.attached) throw new Error('Debugger is not attached');
    this.sent.push({ method, params });
    switch (method) {
      case 'Page.getLayoutMetrics': return { cssVisualViewport: { ...this.layout } };
      case 'Page.captureScreenshot': return this.captureHangs ? new Promise(() => undefined) : { data: jpeg(900, 668) };
      case 'Page.getFrameTree': return this.focus ? { frameTree: { frame: { id: 'main' } } } : {};
      case 'Page.createIsolatedWorld': return { executionContextId: 11 };
      case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'focus-script' };
      case 'Runtime.evaluate': return params?.expression === WATCH_FOCUS_EXPRESSION ? { result: { value: [this.focus, true] } } : {};
      default: return {};
    }
  }
  /** The watcher's binding name, once it added it. */
  binding(): string | undefined { return this.sent.find((s) => s.method === 'Runtime.addBinding')?.params?.name as string | undefined; }
  /** A frame on the page's own session ('') or a child target's. */
  frame(n: number, meta: Record<string, unknown> = {}, session = ''): void {
    this.emit('message', {}, 'Page.screencastFrame', { data: jpeg(900, 668), metadata: { ...META, ...meta }, sessionId: n }, session);
  }
  /** Something let go of the debugger (an unregister, DevTools). */
  detach(): void {
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  }
  acks(): number[] { return this.sent.filter((s) => s.method === 'Page.screencastFrameAck').map((s) => s.params?.sessionId as number); }
  count(method: string): number { return this.sent.filter((s) => s.method === method).length; }
}

class FakeGuest extends EventEmitter {
  readonly debugger = new FakeDebugger();
  destroyed = false;
  url = 'https://a.example.com/start';
  zoom = 1;
  repaints = 0;
  constructor(readonly id: number) { super(); }
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
  getZoomFactor(): number { return this.zoom; }
  invalidate(): void { this.repaints += 1; }
  /** The pane closed: its debugger lets go first, then the guest is destroyed (as Electron does). */
  close(): void {
    this.debugger.detach();
    this.destroyed = true;
    this.emit('destroyed');
  }
  navigate(url: string): void {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    this.url = url;
    this.emit('did-navigate', {}, url, 200, 'OK');
    this.emit('did-stop-loading', {});
  }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('phone browser stream (main): a builtin pane', () => {
  let guests: FakeGuest[];
  let targets: CdpTargetInfo[];
  let visible: Map<string, boolean>;
  let observers: Set<(surfaceId: string, visible: boolean) => void>;
  let native: { width: number; height: number };
  /** While set, the bounds read waits for it. */
  let boundsGate: Promise<void> | null;
  let pushes: Array<Record<string, unknown>>;
  let reply: (params: Record<string, unknown>) => Promise<unknown>;
  let streams: PhoneBrowserStreams;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    guests = [new FakeGuest(7), new FakeGuest(8)];
    targets = [
      { surfaceId: 'surf-a', webContentsId: 7, targetId: 'wc-7', wsUrl: '', workspaceId: 'ws-1' },
      { surfaceId: 'surf-b', webContentsId: 8, targetId: 'wc-8', wsUrl: '', workspaceId: 'ws-2' },
    ];
    visible = new Map();
    observers = new Set();
    native = { width: 900, height: 668 };
    boundsGate = null;
    pushes = [];
    reply = async () => ({ ok: true, known: true });
    const deps: PhoneBrowserStreamDeps = {
      push: (params) => { pushes.push(params); return reply(params); },
      backend: () => 'chrome',
      builtin: {
        targets: () => targets,
        contents: (id) => (guests.find((g) => g.id === id && !g.destroyed) ?? null) as unknown as WebContents | null,
        visible: (surfaceId) => visible.get(surfaceId) ?? true,
        onVisibility: (listener) => { observers.add(listener); return () => { observers.delete(listener); }; },
        nativeBounds: async () => { if (boundsGate) await boundsGate; return native; },
      },
      captureMs: 5_000,
    };
    streams = createPhoneBrowserStreams(deps);
  });
  afterEach(() => { streams.stopAll(); vi.useRealTimers(); });

  const start = async (extra: Record<string, unknown> = {}, surfaceId = 'surf-a', workspaceId = 'ws-1') =>
    streams.handle('browser.streamStart', { workspaceId, surfaceId, streamId: `st-${surfaceId}`, maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 10, ...extra });
  const setVisible = (surfaceId: string, value: boolean) => {
    visible.set(surfaceId, value);
    for (const observer of [...observers]) observer(surfaceId, value);
  };
  const frames = () => pushes.filter((p) => p.kind === 'frame');
  const kinds = () => pushes.filter((p) => p.kind !== 'ping').map((p) => p.kind === 'state' ? `state:${String(p.state)}` : String(p.kind));
  const ends = () => pushes.filter((p) => p.kind === 'end');
  const g = () => guests[0];

  it('starts a screencast on the pane\'s debugger, repaints for the first frame, and answers builtin, whatever the backend setting', async () => {
    expect(await start()).toEqual({ backend: 'builtin', maxWidth: 1280, maxHeight: 1280, quality: 60 });
    const methods = g().debugger.sent.map((s) => s.method);
    expect(methods.slice(0, 2)).toEqual(['Page.getLayoutMetrics', 'Page.startScreencast']);
    expect(g().debugger.sent[1].params).toEqual({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
    expect(g().repaints).toBe(1);
    expect(streams.tab('surf-a', 'ws-1')).toMatchObject({ url: 'https://a.example.com/start', geometry: null });
    // The debugger stays attached; the focus watcher enables Page only, and nothing is ever disabled.
    expect(g().debugger.attached).toBe(true);
    expect(methods.filter((m) => /\.(enable|disable)$/.test(m))).toEqual(['Page.enable']);
  });

  it('refuses a pane it cannot stream, in the preview\'s codes', async () => {
    expect(await start({}, 'surf-gone')).toEqual({ error: 'browser-tab-gone' });
    // Another workspace's pane is not this one's.
    expect(await start({}, 'surf-b', 'ws-1')).toEqual({ error: 'browser-tab-gone' });
    g().url = 'about:blank';
    await expect(start()).rejects.toThrow('Only HTTP');
    expect(g().debugger.count('Page.startScreencast')).toBe(0);
    expect(g().listenerCount('did-navigate')).toBe(0);
  });

  it('pushes the first frame with its URL and geometry (fractional scroll as painted), and acks it only once the daemon answered', async () => {
    let answer!: () => void;
    reply = () => new Promise((resolve) => { answer = () => resolve({ ok: true, known: true }); });
    await start();
    g().debugger.frame(1);
    await flush();
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({
      streamId: 'st-surf-a', kind: 'frame', imageWidth: 900, imageHeight: 668, pageURL: 'https://a.example.com/start',
      geometry: { width: 900, height: 668, scrollX: 0, scrollY: 123.5 },
    });
    expect(g().debugger.acks()).toEqual([]);
    answer();
    await flush();
    expect(g().debugger.acks()).toEqual([1]);
  });

  it('a frame that replaces a waiting one holds its ack until it goes out, as on Chrome', async () => {
    let answer!: () => void;
    reply = (p) => p.kind === 'frame' ? new Promise((resolve) => { answer = () => resolve({ ok: true, known: true }); }) : Promise.resolve({ known: true });
    await start({ maxFps: 15 });
    g().debugger.frame(1);
    await flush();
    g().debugger.frame(2);
    g().debugger.frame(3);
    await flush();
    expect(g().debugger.acks()).toEqual([]);
    answer();
    await vi.advanceTimersByTimeAsync(100);
    expect(g().debugger.acks()).toEqual([1, 2]);
    answer();
    await flush();
    expect(g().debugger.acks()).toEqual([1, 2, 3]);
  });

  it('a frame of a child session is not the page\'s', async () => {
    await start();
    g().debugger.frame(1, {}, 'child-session');
    await vi.advanceTimersByTimeAsync(100);
    expect(frames()).toEqual([]);
    expect(g().debugger.acks()).toEqual([]);
  });

  it('a still page that paints nothing gets a captured first frame after a second', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(g().debugger.count('Page.captureScreenshot')).toBe(1);
    expect(frames()[0]).toMatchObject({ pageURL: 'https://a.example.com/start', geometry: { width: 900, height: 668, scrollX: 0, scrollY: 123.5 } });
  });

  it('tracks the URL from the guest\'s navigation events: start, commit, in-page, and a load that stops without one', async () => {
    await start({ maxFps: 15 });
    const next = async (n: number) => { g().debugger.frame(n); await vi.advanceTimersByTimeAsync(100); return frames().at(-1)!; };
    // A same-document start and a subframe's do not hide anything.
    g().emit('did-start-navigation', { url: 'https://a.example.com/start#x', isMainFrame: true, isSameDocument: true });
    g().emit('did-start-navigation', { url: 'https://ads.example.com/', isMainFrame: false, isSameDocument: false });
    expect(await next(1)).toMatchObject({ pageURL: 'https://a.example.com/start', geometry: { width: 900 } });
    // A cross-document start: no URL and no geometry until it commits.
    g().emit('did-start-navigation', { url: 'https://b.example.com/', isMainFrame: true, isSameDocument: false });
    const mid = await next(2);
    expect(mid).not.toHaveProperty('pageURL');
    expect(mid).not.toHaveProperty('geometry');
    // It became a download: the load stops, nothing committed, the page is as it was.
    g().emit('did-stop-loading', {});
    expect(await next(3)).toMatchObject({ pageURL: 'https://a.example.com/start', geometry: { width: 900 } });
    g().navigate('https://b.example.com/');
    await vi.advanceTimersByTimeAsync(100);
    const view = streams.tab('surf-a', 'ws-1')!;
    expect(view.url).toBe('https://b.example.com/');
    expect(pushes.filter((p) => p.kind === 'url').at(-1)).toEqual({ streamId: 'st-surf-a', kind: 'url', pageURL: 'https://b.example.com/' });
    g().emit('did-navigate-in-page', {}, 'https://b.example.com/route-1', true, 1, 1);
    g().emit('did-navigate-in-page', {}, 'https://ads.example.com/frame#2', false, 1, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(view.url).toBe('https://b.example.com/route-1');
    expect([...view.docUrls]).toEqual(['https://b.example.com/', 'https://b.example.com/route-1']);
    expect(pushes.filter((p) => p.kind === 'url').at(-1)).toEqual({ streamId: 'st-surf-a', kind: 'url', pageURL: 'https://b.example.com/route-1' });
    expect((await next(4)).pageURL).toBe('https://b.example.com/route-1');
  });

  it('a page that is not http(s) is a url event without its URL and sends no frames; an error page commits at its URL', async () => {
    await start();
    g().debugger.frame(1);
    await flush();
    g().navigate('about:blank');
    await vi.advanceTimersByTimeAsync(100);
    expect(pushes.filter((p) => p.kind === 'url')).toEqual([{ streamId: 'st-surf-a', kind: 'url' }]);
    const view = streams.tab('surf-a', 'ws-1')!;
    expect(view.url).toBeNull();
    expect(view.docUrls.size).toBe(0);
    g().debugger.frame(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(frames()).toHaveLength(1);
    expect(g().debugger.acks()).toContain(2);
    expect(g().debugger.count('Page.stopScreencast')).toBe(0);
    // A load that failed: the guest shows its error page at the URL it was for.
    g().emit('did-start-navigation', { url: 'https://down.example.com/', isMainFrame: true, isSameDocument: false });
    g().url = 'https://down.example.com/';
    g().emit('did-fail-provisional-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://down.example.com/', true, 1, 1);
    g().debugger.frame(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(pushes.filter((p) => p.kind === 'url').at(-1)).toEqual({ streamId: 'st-surf-a', kind: 'url', pageURL: 'https://down.example.com/' });
    expect(frames().at(-1)).toMatchObject({ pageURL: 'https://down.example.com/', geometry: { width: 900 } });
    // An aborted load (a download, a 204, mailto:) commits nothing: the page on screen stays, URL and all.
    const urls = pushes.filter((p) => p.kind === 'url').length;
    for (const link of ['https://down.example.com/file.zip', 'mailto:a@example.com']) {
      g().emit('did-start-navigation', { url: link, isMainFrame: true, isSameDocument: false });
      g().emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', link, true, 1, 1);
    }
    g().debugger.frame(4);
    await vi.advanceTimersByTimeAsync(200);
    expect(pushes.filter((p) => p.kind === 'url')).toHaveLength(urls);
    expect(frames().at(-1)).toMatchObject({ pageURL: 'https://down.example.com/', geometry: { width: 900 } });
  });

  it('a stream stopped while it starts leaves no screencast running on the pane', async () => {
    let open!: () => void;
    boundsGate = new Promise<void>((resolve) => { open = resolve; });
    const started = start();
    await flush();
    streams.stopAll();
    open();
    expect(await started).toEqual({ error: 'browser-tab-gone' });
    await flush();
    const sent = g().debugger.sent.map((x) => x.method);
    expect(sent.filter((m) => m === 'Page.startScreencast')).toEqual([]);
  });

  it('hidden and live follow the renderer\'s visibility reports, never silence', async () => {
    await start();
    g().debugger.frame(1);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    // A still page in view: never probed, never called hidden.
    expect(g().debugger.count('Runtime.evaluate')).toBe(0);
    expect(kinds()).toEqual(['frame']);
    setVisible('surf-b', false);
    expect(kinds()).toEqual(['frame']);
    setVisible('surf-a', false);
    await flush();
    expect(kinds()).toEqual(['frame', 'state:hidden']);
    // Painted while off screen: acked, not sent.
    g().debugger.frame(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(kinds()).toEqual(['frame', 'state:hidden']);
    expect(g().debugger.acks()).toContain(2);
    const repaints = g().repaints;
    setVisible('surf-a', true);
    expect(g().repaints).toBe(repaints + 1);
    g().debugger.frame(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(kinds()).toEqual(['frame', 'state:hidden', 'state:live', 'frame']);
  });

  it('back on screen with nothing painted: the capture brings live and a frame', async () => {
    visible.set('surf-a', false);
    await start();
    await flush();
    expect(kinds()).toEqual(['state:hidden']);
    // Hidden from the start: no capture of a pane that is off screen.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(g().debugger.count('Page.captureScreenshot')).toBe(0);
    setVisible('surf-a', true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(g().debugger.count('Page.captureScreenshot')).toBe(1);
    expect(kinds()).toEqual(['state:hidden', 'state:live', 'frame']);
  });

  it('geometry is left out at a zoom other than 100 % and while the viewport is larger than the widget', async () => {
    await start({ maxFps: 15 });
    const next = async (n: number) => { g().debugger.frame(n); await vi.advanceTimersByTimeAsync(100); return frames().at(-1)!; };
    g().zoom = 1.25;
    // At 125 % the metadata stays in device pixels (900 wide, 154.5 down) while the page is 720 CSS pixels wide.
    const zoomed = await next(1);
    expect(zoomed).not.toHaveProperty('geometry');
    expect(zoomed.pageURL).toBe('https://a.example.com/start');
    expect(streams.tab('surf-a', 'ws-1')?.geometry).toBeNull();
    g().zoom = 1;
    expect(await next(2)).toMatchObject({ geometry: { width: 900 } });
    // An agent emulated a viewport wider than the pane: read every 2 s while frames flow.
    g().debugger.layout = { ...g().debugger.layout, clientWidth: 1920, clientHeight: 1080 };
    for (let n = 3; n < 30; n++) await next(n);
    expect(frames().at(-1)).not.toHaveProperty('geometry');
    g().debugger.layout = { ...g().debugger.layout, clientWidth: 900, clientHeight: 668 };
    for (let n = 30; n < 60; n++) await next(n);
    expect(frames().at(-1)).toMatchObject({ geometry: { width: 900 } });
  });

  it('the pane closing ends the stream once with browser-tab-gone, though its debugger let go first', async () => {
    await start();
    g().close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ends()).toEqual([{ streamId: 'st-surf-a', kind: 'end', error: 'browser-tab-gone' }]);
    expect(streams.tab('surf-a', 'ws-1')).toBeNull();
    expect(g().listenerCount('destroyed')).toBe(0);
  });

  it('the debugger taken from a pane still registered (DevTools) ends it with browser-preview-unavailable', async () => {
    await start();
    g().debugger.detach();
    await vi.advanceTimersByTimeAsync(499);
    expect(ends()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ends()).toEqual([{ streamId: 'st-surf-a', kind: 'end', error: 'browser-preview-unavailable' }]);
    expect(g().debugger.listenerCount('message')).toBe(0);
    expect(g().debugger.listenerCount('detach')).toBe(0);
  });

  it('unregistered (discarded by lightweight mode, or replaced) ends it with browser-tab-gone', async () => {
    await start();
    // WebviewCdpManager.unregister: the debugger lets go, the session is dropped, the guest lives on.
    targets = targets.filter((t) => t.surfaceId !== 'surf-a');
    g().debugger.detach();
    await vi.advanceTimersByTimeAsync(500);
    expect(ends()).toEqual([{ streamId: 'st-surf-a', kind: 'end', error: 'browser-tab-gone' }]);
    // With no detach at all, the tick finds it.
    pushes = [];
    await start({}, 'surf-b', 'ws-2');
    targets = [{ ...targets[0], webContentsId: 99 }];
    await vi.advanceTimersByTimeAsync(500);
    expect(ends()).toEqual([{ streamId: 'st-surf-b', kind: 'end', error: 'browser-tab-gone' }]);
  });

  it('a frame from a pane no longer this workspace\'s ends the stream', async () => {
    await start();
    targets = [{ ...targets[0], workspaceId: 'ws-9' }, targets[1]];
    g().debugger.frame(1);
    await flush();
    expect(ends()).toEqual([{ streamId: 'st-surf-a', kind: 'end', error: 'browser-tab-gone' }]);
  });

  it('stop stops the screencast and lets go of everything it listened to, leaving the debugger attached', async () => {
    await start();
    const listeners = () => ['destroyed', 'did-start-navigation', 'did-navigate', 'did-fail-provisional-load', 'did-navigate-in-page', 'did-stop-loading']
      .reduce((n, event) => n + g().listenerCount(event), 0) + g().debugger.listenerCount('message') + g().debugger.listenerCount('detach');
    expect(listeners()).toBe(8);
    expect(observers.size).toBe(1);
    expect(await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'surf-a', streamId: 'st-surf-a' })).toEqual({ applied: true });
    await flush();
    expect(g().debugger.count('Page.stopScreencast')).toBe(1);
    expect(listeners()).toBe(0);
    expect(observers.size).toBe(0);
    expect(g().debugger.attached).toBe(true);
    expect(streams.tab('surf-a', 'ws-1')).toBeNull();
  });

  it('focus: watched on the pane\'s debugger without Runtime.enable, each change pushed, paced like url events', async () => {
    g().debugger.focus = { editable: false };
    await start();
    await flush();
    const focus = () => pushes.filter((p) => p.kind === 'focus');
    expect(focus()).toEqual([{ streamId: 'st-surf-a', kind: 'focus', focus: { editable: false } }]);
    const sent = () => g().debugger.sent.map((x) => x.method);
    expect(sent()).not.toContain('Runtime.enable');
    expect(g().debugger.sent.find((x) => x.method === 'Runtime.addBinding')?.params).toEqual({ name: g().debugger.binding(), executionContextId: 11 });
    const nudge = (session = '') => g().debugger.emit('message', {}, 'Runtime.bindingCalled', { name: g().debugger.binding(), payload: '' }, session);
    g().debugger.focus = { editable: true, kind: 'text' };
    // A child target's call is not this page's.
    nudge('child-session');
    await flush();
    expect(focus()).toHaveLength(1);
    nudge();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(focus().at(-1)?.focus).toEqual({ editable: true, kind: 'text' });
    // Two changes inside 100 ms: the second waits its turn, and the last one always goes.
    g().debugger.focus = { editable: true, kind: 'password' };
    nudge();
    await flush();
    g().debugger.focus = { editable: false };
    nudge();
    await flush();
    const before = focus().length;
    await vi.advanceTimersByTimeAsync(100);
    expect(focus().length).toBeGreaterThan(before);
    expect(focus().at(-1)?.focus).toEqual({ editable: false });
    // A commit resets it at once.
    g().debugger.focus = { editable: true, kind: 'search' };
    nudge();
    await vi.advanceTimersByTimeAsync(100);
    expect(focus().at(-1)?.focus).toEqual({ editable: true, kind: 'search' });
    g().debugger.focus = { editable: false };
    g().debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://a.example.com/next' } }, '');
    await vi.advanceTimersByTimeAsync(100);
    expect(focus().at(-1)?.focus).toEqual({ editable: false });
  });

  it('focus: stop takes the watcher\'s binding and detector back from the shared debugger and leaves no listener', async () => {
    g().debugger.focus = { editable: false };
    await start();
    await flush();
    expect(g().debugger.listenerCount('message')).toBe(3);
    await streams.handle('browser.streamStop', { workspaceId: 'ws-1', surfaceId: 'surf-a', streamId: 'st-surf-a' });
    await flush();
    expect(g().debugger.listenerCount('message')).toBe(0);
    expect(g().debugger.sent.filter((x) => x.method === 'Runtime.removeBinding' || x.method === 'Page.removeScriptToEvaluateOnNewDocument').map((x) => x.params))
      .toEqual([{ name: g().debugger.binding() }, { identifier: 'focus-script' }]);
    expect(g().debugger.sent.map((x) => x.method).filter((m) => /\.disable$/.test(m))).toEqual([]);
    const pushed = pushes.length;
    g().debugger.focus = { editable: true, kind: 'text' };
    g().debugger.emit('message', {}, 'Runtime.bindingCalled', { name: g().debugger.binding(), payload: '' }, '');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pushes.length).toBe(pushed);
  });

  it('focus: a stream stopped while it starts starts no watcher', async () => {
    g().debugger.focus = { editable: false };
    let open!: () => void;
    boundsGate = new Promise<void>((resolve) => { open = resolve; });
    const started = start();
    await flush();
    streams.stopAll();
    open();
    await started;
    await flush();
    expect(g().debugger.sent.map((x) => x.method)).not.toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(pushes.filter((p) => p.kind === 'focus')).toEqual([]);
  });

  it('known:false from the daemon stops the screencast; pings run as on Chrome', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pushes.filter((p) => p.kind === 'ping')).toHaveLength(1);
    reply = async () => ({ ok: false, known: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(streams.tab('surf-a', 'ws-1')).toBeNull();
    expect(g().debugger.count('Page.stopScreencast')).toBe(1);
  });
});
