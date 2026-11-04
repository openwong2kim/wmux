import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BrowserStreamRegistry, parseBrowserStreamQuery, type BrowserStreamDesktop, type BrowserStreamParams,
  type BrowserStreamRefusal, type BrowserStreamReservation, type BrowserStreamSink, type BrowserStreamWho,
} from '../browserStream';

/**
 * The daemon's side of the phone browser stream, with fake timers: what each
 * subscriber is written, in which order and how often; the caps; the start's
 * singleflight; and every way a stream ends.
 */

const FRAME = 'QUJD'; // "ABC"
const PARAMS: BrowserStreamParams = { maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 10 };
const OPERATOR: BrowserStreamWho = { principalKey: 'operator', operator: true };
const device = (id: string): BrowserStreamWho => ({ principalKey: id, operator: false, deviceId: id });

class FakeSink implements BrowserStreamSink {
  chunks: string[] = [];
  private waiting: Array<() => void> = [];
  stalled = false;
  destroyed = false;
  ended = false;
  private closers: Array<() => void> = [];
  get writableLength(): number { return this.waiting.length > 0 ? 1 : 0; }
  write(chunk: string, callback?: () => void): boolean {
    this.chunks.push(chunk);
    if (this.stalled) this.waiting.push(() => callback?.());
    else queueMicrotask(() => callback?.());
    return !this.stalled;
  }
  /** The client reads again: everything queued goes out. */
  release(): void {
    this.stalled = false;
    const waiting = this.waiting;
    this.waiting = [];
    for (const done of waiting) done();
  }
  end(): void { this.ended = true; this.fireClose(); }
  destroy(): void { this.destroyed = true; this.fireClose(); }
  once(_event: 'close', listener: () => void): unknown { this.closers.push(listener); return this; }
  private fireClose(): void { const closers = this.closers; this.closers = []; for (const c of closers) c(); }
  /** The SSE events written, keepalives as `:`. */
  events(): Array<{ event: string; data?: Record<string, unknown> }> {
    return this.chunks.map((chunk) => {
      if (chunk.startsWith(':')) return { event: ':' };
      const [line1, line2] = chunk.split('\n');
      return { event: line1.slice('event: '.length), data: JSON.parse(line2.slice('data: '.length)) as Record<string, unknown> };
    });
  }
  named(event: string) { return this.events().filter((e) => e.event === event); }
}

class FakeDesktop implements BrowserStreamDesktop {
  ownerId: string | null = 'main';
  requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
  private lost: Array<() => void> = [];
  /** Starts answered only when the test says so. */
  defer = false;
  private parked: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  startReply: (payload: Record<string, unknown>) => unknown = (p) => ({ backend: 'chrome', maxWidth: p.maxWidth, maxHeight: p.maxHeight, quality: p.quality });
  request(command: string, payload: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ command, payload });
    if (command !== 'browser.streamStart') return Promise.resolve({ ok: true });
    if (!this.defer) return Promise.resolve(this.startReply(payload));
    return new Promise((resolve, reject) => this.parked.push({ resolve: (v) => resolve(v ?? this.startReply(payload)), reject }));
  }
  finishStarts(): void { for (const p of this.parked.splice(0)) p.resolve(undefined); }
  onOwnerLost(listener: () => void): () => void { this.lost.push(listener); return () => undefined; }
  loseOwner(): void {
    this.ownerId = null;
    for (const p of this.parked.splice(0)) p.reject(new Error('desktop-disconnected'));
    for (const l of this.lost) l();
  }
  commands(): string[] { return this.requests.map((r) => r.command); }
}

const flushMicrotasks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('BrowserStreamRegistry', () => {
  let registry: BrowserStreamRegistry;
  let desktop: FakeDesktop;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    registry = new BrowserStreamRegistry();
    desktop = new FakeDesktop();
  });
  afterEach(() => { vi.useRealTimers(); });

  function reserve(who: BrowserStreamWho = OPERATOR, params: Partial<BrowserStreamParams> = {}, surfaceId = 'chrome-a'): BrowserStreamReservation {
    const r = registry.reserve(desktop, 'ws-1', surfaceId, who, { ...PARAMS, ...params });
    if ('status' in r) throw new Error(`refused: ${r.error}`);
    return r;
  }
  async function subscribe(who: BrowserStreamWho = OPERATOR, params: Partial<BrowserStreamParams> = {}, authorize = () => true, surfaceId = 'chrome-a') {
    const reservation = reserve(who, params, surfaceId);
    const started = await reservation.start();
    expect('status' in started).toBe(false);
    const sink = new FakeSink();
    expect(reservation.open(sink, authorize, () => undefined)).toBeNull();
    await flushMicrotasks();
    return { sink, reservation };
  }
  const streamId = () => desktop.requests.find((r) => r.command === 'browser.streamStart')!.payload.streamId as string;
  const frame = (extra: Record<string, unknown> = {}) => ({ streamId: streamId(), kind: 'frame', data: FRAME, capturedAt: 1, imageWidth: 100, imageHeight: 50, ...extra });
  /** Time passing with main pinging every 15 s, as it does. */
  async function pinging(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 15_000) {
      await vi.advanceTimersByTimeAsync(Math.min(15_000, left));
      registry.push('main', { streamId: streamId(), kind: 'ping' });
    }
  }

  it('parses the query: clamps numbers, refuses what is not one, takes only viewport=mobile', () => {
    expect(parseBrowserStreamQuery(new URLSearchParams(''))).toEqual({ maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 10, mobile: false });
    expect(parseBrowserStreamQuery(new URLSearchParams('maxWidth=99999&maxHeight=1&quality=100&maxFps=0&viewport=mobile')))
      .toEqual({ maxWidth: 1920, maxHeight: 320, quality: 85, maxFps: 1, mobile: true });
    for (const bad of ['maxWidth=abc', 'quality=-1', 'maxFps=1.5', 'viewport=desktop', 'maxWidth=']) {
      expect(parseBrowserStreamQuery(new URLSearchParams(bad))).toBeNull();
    }
  });

  it('writes hello first, then the latest frame, with seq counted per subscriber', async () => {
    const a = await subscribe(OPERATOR, { maxFps: 15 });
    expect(desktop.requests[0]).toMatchObject({ command: 'browser.streamStart', payload: { workspaceId: 'ws-1', surfaceId: 'chrome-a', maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 15 } });
    expect(registry.push('main', frame({ pageURL: 'https://a.example.com/', geometry: { width: 800, height: 600, scrollX: 0, scrollY: 10 } }))).toEqual({ ok: true, known: true });
    await flushMicrotasks();
    const b = await subscribe(device('d1'), { maxFps: 5, maxWidth: 640 });
    // One shared screencast: no second start, and the hello echoes the shared size.
    expect(desktop.commands().filter((c) => c === 'browser.streamStart')).toHaveLength(1);
    expect(b.sink.events()[0]).toEqual({ event: 'hello', data: { v: 1, surfaceId: 'chrome-a', backend: 'chrome', maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 5 } });
    expect(b.sink.events()[1]).toEqual({ event: 'frame', data: { seq: 1, data: FRAME, mimeType: 'image/jpeg', capturedAt: 1, imageWidth: 100, imageHeight: 50, pageURL: 'https://a.example.com/', geometry: { width: 800, height: 600, scrollX: 0, scrollY: 10 } } });
    vi.advanceTimersByTime(300);
    registry.push('main', frame({ capturedAt: 2 }));
    await flushMicrotasks();
    expect(a.sink.named('frame').map((e) => e.data?.seq)).toEqual([1, 2]);
    expect(b.sink.named('frame').map((e) => e.data?.seq)).toEqual([1, 2]);
  });

  it('keeps only the latest frame while the client has not taken the last one', async () => {
    const { sink } = await subscribe();
    sink.stalled = true;
    registry.push('main', frame({ capturedAt: 1 }));
    vi.advanceTimersByTime(500);
    registry.push('main', frame({ capturedAt: 2 }));
    registry.push('main', frame({ capturedAt: 3 }));
    vi.advanceTimersByTime(500);
    expect(sink.named('frame').map((e) => e.data?.capturedAt)).toEqual([1]);
    sink.release();
    await flushMicrotasks();
    expect(sink.named('frame').map((e) => [e.data?.seq, e.data?.capturedAt])).toEqual([[1, 1], [2, 3]]);
  });

  it('paces each subscriber to its own maxFps, ending on the latest frame', async () => {
    const slow = await subscribe(device('d1'), { maxFps: 2 });
    const fast = await subscribe(device('d2'), { maxFps: 10 });
    for (let i = 1; i <= 10; i++) {
      registry.push('main', frame({ capturedAt: i }));
      await flushMicrotasks();
      vi.advanceTimersByTime(100);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(fast.sink.named('frame')).toHaveLength(10);
    const slowFrames = slow.sink.named('frame');
    expect(slowFrames.length).toBeGreaterThanOrEqual(2);
    expect(slowFrames.length).toBeLessThanOrEqual(3);
    expect(slowFrames.at(-1)?.data?.capturedAt).toBe(10);
    // Main was started at the first subscriber's 2 fps; each higher maxFps reached it.
    expect(desktop.requests[0].payload.maxFps).toBe(2);
    await subscribe(device('d3'), { maxFps: 5 });
    await subscribe(device('d4'), { maxFps: 15 });
    expect(desktop.requests.filter((r) => r.command === 'browser.streamUpdate').map((r) => r.payload.maxFps)).toEqual([10, 15]);
  });

  it('takes four subscribers per tab, two per device per tab, and four tabs', async () => {
    const r = (who: BrowserStreamWho, surfaceId = 'chrome-a') => registry.reserve(desktop, 'ws-1', surfaceId, who, PARAMS);
    expect('status' in r(device('d1'))).toBe(false);
    expect('status' in r(device('d1'))).toBe(false);
    expect(r(device('d1'))).toEqual({ status: 429, error: 'too-many-streams', retryAfter: 1 });
    // The operator has no per-principal cap, but the tab's cap holds for it too.
    expect('status' in r(OPERATOR)).toBe(false);
    expect('status' in r(OPERATOR)).toBe(false);
    expect(r(OPERATOR)).toEqual({ status: 429, error: 'too-many-streams', retryAfter: 1 });
    for (const tab of ['chrome-b', 'chrome-c', 'chrome-d']) expect('status' in r(OPERATOR, tab)).toBe(false);
    expect(r(OPERATOR, 'chrome-e')).toMatchObject({ status: 429 });
  });

  it('shares one start, and a start everyone left is stopped once it completes', async () => {
    desktop.defer = true;
    const a = reserve(device('d1'));
    const b = reserve(device('d2'));
    const pa = a.start();
    const pb = b.start();
    await flushMicrotasks();
    expect(desktop.commands()).toEqual(['browser.streamStart']);
    a.cancel();
    b.cancel();
    expect(desktop.commands()).toEqual(['browser.streamStart']);
    desktop.finishStarts();
    await Promise.all([pa, pb]);
    await flushMicrotasks();
    expect(desktop.commands()).toEqual(['browser.streamStart', 'browser.streamStop']);
    expect(desktop.requests[1].payload.streamId).toBe(desktop.requests[0].payload.streamId);
    // The next subscriber starts afresh.
    desktop.defer = false;
    await subscribe();
    expect(desktop.commands().filter((c) => c === 'browser.streamStart')).toHaveLength(2);
  });

  it('a second subscriber joining a start in flight opens on the same screencast', async () => {
    desktop.defer = true;
    const a = reserve(device('d1'));
    const b = reserve(device('d2'));
    const [pa, pb] = [a.start(), b.start()];
    desktop.finishStarts();
    expect('status' in (await pa)).toBe(false);
    expect('status' in (await pb)).toBe(false);
    const sa = new FakeSink();
    const sb = new FakeSink();
    expect(a.open(sa, () => true, () => undefined)).toBeNull();
    expect(b.open(sb, () => true, () => undefined)).toBeNull();
    registry.push('main', frame());
    await flushMicrotasks();
    expect(sa.named('frame')).toHaveLength(1);
    expect(sb.named('frame')).toHaveLength(1);
    expect(desktop.commands()).toEqual(['browser.streamStart']);
  });

  it('owner lost: a start in flight fails, and open streams end with browser-backend-unavailable', async () => {
    const open = await subscribe(device('d1'));
    desktop.defer = true;
    const pending = reserve(device('d2'), {}, 'chrome-b');
    const started = pending.start();
    await flushMicrotasks();
    desktop.loseOwner();
    expect(await started).toEqual({ status: 503, error: 'browser-preview-unavailable' });
    pending.cancel();
    expect(open.sink.named('end')).toEqual([{ event: 'end', data: { error: 'browser-backend-unavailable' } }]);
    expect(open.sink.ended).toBe(true);
    // Nobody to tell: no stop goes out.
    expect(desktop.commands()).not.toContain('browser.streamStop');
    expect(registry.size).toBe(0);
  });

  it('main\'s end closes the tab\'s streams; a subscriber still starting hears the code', async () => {
    const open = await subscribe(device('d1'));
    const late = reserve(device('d2'));
    expect(registry.push('main', { streamId: streamId(), kind: 'end', error: 'browser-tab-gone' })).toEqual({ ok: true, known: true });
    expect(open.sink.named('end')).toEqual([{ event: 'end', data: { error: 'browser-tab-gone' } }]);
    expect(late.open(new FakeSink(), () => true, () => { throw new Error('must not begin'); })).toEqual({ status: 404, error: 'browser-tab-gone' });
    // The stream is unknown from now on: main stops pushing.
    expect(registry.push('main', frame())).toEqual({ ok: false, known: false });
    expect(desktop.commands()).not.toContain('browser.streamStop');
  });

  it('writes a keepalive every 15 s and closes a client that stopped reading', async () => {
    const { sink } = await subscribe();
    await pinging(15_000);
    expect(sink.events().at(-1)).toEqual({ event: ':' });
    sink.stalled = true;
    await pinging(15_000);
    expect(sink.destroyed).toBe(false);
    await pinging(15_000);
    expect(sink.destroyed).toBe(true);
    expect(desktop.commands()).toContain('browser.streamStop');
  });

  it('closes without end once the authorization no longer holds, at the next tick', async () => {
    let allowed = true;
    const { sink } = await subscribe(device('d1'), {}, () => allowed);
    allowed = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sink.ended).toBe(true);
    expect(sink.named('end')).toEqual([]);
    expect(desktop.commands()).toContain('browser.streamStop');
  });

  it('ends a stream after 30 minutes with browser-stream-expired', async () => {
    const { sink } = await subscribe();
    await pinging(30 * 60_000 - 1);
    expect(sink.named('end')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.named('end')).toEqual([{ event: 'end', data: { error: 'browser-stream-expired' } }]);
    expect(sink.ended).toBe(true);
  });

  it('a revoked device\'s streams close with no end; others stay', async () => {
    const phone = await subscribe(device('d1'));
    const op = await subscribe(OPERATOR);
    expect(registry.closeDevice('d1')).toBe(1);
    expect(phone.sink.ended).toBe(true);
    expect(phone.sink.named('end')).toEqual([]);
    expect(op.sink.ended).toBe(false);
    expect(desktop.commands()).not.toContain('browser.streamStop');
    registry.stopAll();
    expect(op.sink.ended).toBe(true);
    expect(desktop.commands()).toContain('browser.streamStop');
  });

  it('checks every push: owner, stream, frame fields, URL and geometry', async () => {
    const { sink } = await subscribe();
    expect(registry.push('other', frame())).toEqual({ ok: false, known: false });
    expect(registry.push('main', { ...frame(), streamId: 'nope' })).toEqual({ ok: false, known: false });
    for (const bad of [
      { data: 'not base64!' }, { data: 'A'.repeat(700 * 1024 + 4) }, { data: '' }, { capturedAt: 'now' }, { imageWidth: 0 },
      { pageURL: 'javascript:alert(1)' }, { pageURL: `https://a.example.com/${'x'.repeat(4096)}` }, { pageURL: 'https://u:p@a.example.com/' },
      { pageURL: 'https://a.example.com/', geometry: { width: 1, height: 1, scrollX: NaN, scrollY: 0 } },
      { pageURL: 'https://a.example.com/', geometry: { width: 1, height: 1, scrollX: 0, scrollY: 0, scale: -1 } },
    ]) expect(registry.push('main', frame(bad))).toEqual({ ok: false, known: true });
    await flushMicrotasks();
    expect(sink.named('frame')).toEqual([]);
    // The server names the type, and geometry without a page URL is left out.
    expect(registry.push('main', frame({ mimeType: 'text/html', geometry: { width: 1, height: 1, scrollX: 0, scrollY: 0 }, extra: 'x' }))).toEqual({ ok: true, known: true });
    await flushMicrotasks();
    expect(sink.named('frame')[0].data).toEqual({ seq: 1, data: FRAME, mimeType: 'image/jpeg', capturedAt: 1, imageWidth: 100, imageHeight: 50 });
    expect(registry.push('main', { streamId: streamId(), kind: 'ping' })).toEqual({ ok: true, known: true });
    expect(registry.push('main', { streamId: streamId(), kind: 'bogus' })).toEqual({ ok: false, known: true });
  });

  it('coalesces url events to ten a second, in order with frames, the last one always written', async () => {
    const { sink } = await subscribe();
    const url = (pageURL?: string) => registry.push('main', { streamId: streamId(), kind: 'url', ...(pageURL ? { pageURL } : {}) });
    expect(url('https://a.example.com/?q=a')).toEqual({ ok: true, known: true });
    url('https://a.example.com/?q=ab');
    url('https://a.example.com/?q=abc');
    registry.push('main', frame({ capturedAt: 9 }));
    await flushMicrotasks();
    expect(sink.events().slice(1).map((e) => e.event)).toEqual(['url']);
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.events().slice(1).map((e) => [e.event, e.data?.pageURL ?? e.data?.capturedAt])).toEqual([
      ['url', 'https://a.example.com/?q=a'], ['url', 'https://a.example.com/?q=abc'], ['frame', 9],
    ]);
    expect(url()).toEqual({ ok: true, known: true });
    expect(url('file:///etc/passwd')).toEqual({ ok: false, known: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.named('url').at(-1)?.data).toEqual({});
  });

  it('a late subscriber gets the latest frame, then a url event that came after it', async () => {
    await subscribe(device('d1'));
    registry.push('main', frame({ pageURL: 'https://a.example.com/' }));
    registry.push('main', { streamId: streamId(), kind: 'url', pageURL: 'https://a.example.com/#s2' });
    const late = await subscribe(device('d2'));
    await vi.advanceTimersByTimeAsync(100);
    expect(late.sink.events().slice(1).map((e) => [e.event, e.data?.pageURL])).toEqual([
      ['frame', 'https://a.example.com/'], ['url', 'https://a.example.com/#s2'],
    ]);
    // A frame after the url carries it: a later subscriber needs no url event.
    registry.push('main', frame({ pageURL: 'https://a.example.com/#s2' }));
    const later = await subscribe(OPERATOR);
    await vi.advanceTimersByTimeAsync(100);
    expect(later.sink.named('url')).toEqual([]);
  });

  it('ends the tab with browser-backend-unavailable when main has pushed nothing for 45 s', async () => {
    const { sink } = await subscribe();
    await pinging(30_000);
    expect(sink.named('end')).toEqual([]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sink.named('end')).toEqual([{ event: 'end', data: { error: 'browser-backend-unavailable' } }]);
    expect(registry.push('main', { streamId: streamId(), kind: 'ping' })).toEqual({ ok: false, known: false });
  });

  it('state events reach open streams and a late subscriber', async () => {
    const a = await subscribe(device('d1'));
    registry.push('main', { streamId: streamId(), kind: 'state', state: 'hidden' });
    await flushMicrotasks();
    expect(a.sink.named('state')).toEqual([{ event: 'state', data: { state: 'hidden', reason: 'browser-tab-hidden' } }]);
    const b = await subscribe(device('d2'));
    expect(b.sink.named('state')).toEqual([{ event: 'state', data: { state: 'hidden', reason: 'browser-tab-hidden' } }]);
    registry.push('main', { streamId: streamId(), kind: 'state', state: 'live' });
    await flushMicrotasks();
    expect(a.sink.named('state').at(-1)?.data).toEqual({ state: 'live' });
  });

  it('focus: checks the shape and kind, sends only changes, paced like url, the last one always written', async () => {
    const { sink } = await subscribe();
    const focus = (value: unknown) => registry.push('main', { streamId: streamId(), kind: 'focus', focus: value });
    for (const bad of [undefined, null, 'text', { editable: 'yes' }, { editable: true, kind: 'select' }, { editable: false, kind: 'text' }]) {
      expect(focus(bad)).toEqual({ ok: false, known: true });
    }
    // A flat push (no `focus` object) is not one either.
    expect(registry.push('main', { streamId: streamId(), kind: 'focus', editable: true })).toEqual({ ok: false, known: true });
    expect(focus({ editable: true, kind: 'text', value: 'secret', id: 'q' })).toEqual({ ok: true, known: true });
    focus({ editable: true, kind: 'password' });
    focus({ editable: false });
    registry.push('main', frame({ capturedAt: 9 }));
    await flushMicrotasks();
    expect(sink.events().slice(1).map((e) => e.event)).toEqual(['focus']);
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.events().slice(1).map((e) => [e.event, e.event === 'focus' ? e.data : e.data?.capturedAt])).toEqual([
      ['focus', { editable: true, kind: 'text' }], ['focus', { editable: false }], ['frame', 9],
    ]);
    // The same state again is not a change.
    expect(focus({ editable: false })).toEqual({ ok: true, known: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(sink.named('focus')).toHaveLength(2);
    expect(JSON.stringify(sink.chunks)).not.toContain('secret');
    // Away and back before this subscriber took the change: it hears nothing new.
    focus({ editable: true, kind: 'search' });
    focus({ editable: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(sink.named('focus')).toHaveLength(2);
  });

  it('a late subscriber gets the tab\'s focus after the latest frame', async () => {
    await subscribe(device('d1'));
    registry.push('main', { streamId: streamId(), kind: 'focus', focus: { editable: true, kind: 'search' } });
    registry.push('main', frame({ pageURL: 'https://a.example.com/' }));
    registry.push('main', { streamId: streamId(), kind: 'url', pageURL: 'https://a.example.com/#s2' });
    const late = await subscribe(device('d2'));
    await vi.advanceTimersByTimeAsync(100);
    expect(late.sink.events().slice(1).map((e) => e.event)).toEqual(['frame', 'url', 'focus']);
    expect(late.sink.named('focus')[0].data).toEqual({ editable: true, kind: 'search' });
    // Not editable is a state too: a later subscriber hears it.
    registry.push('main', { streamId: streamId(), kind: 'focus', focus: { editable: false } });
    const later = await subscribe(OPERATOR);
    await vi.advanceTimersByTimeAsync(100);
    expect(later.sink.named('focus').map((e) => e.data)).toEqual([{ editable: false }]);
  });

  it('a tab main never sent a focus for gives a late subscriber none', async () => {
    await subscribe(device('d1'));
    registry.push('main', frame());
    const late = await subscribe(device('d2'));
    await vi.advanceTimersByTimeAsync(100);
    expect(late.sink.named('focus')).toEqual([]);
  });

  it('maps main\'s refusal at start to its status, and a failed start to 503', async () => {
    desktop.startReply = () => ({ error: 'browser-tab-gone' });
    expect(await reserve().start()).toEqual({ status: 404, error: 'browser-tab-gone' } satisfies BrowserStreamRefusal);
    desktop.startReply = () => ({ error: 'whatever' });
    expect(await reserve().start()).toEqual({ status: 503, error: 'browser-preview-unavailable' });
    desktop.startReply = () => ({ backend: 'chrome' });
    expect(await reserve().start()).toEqual({ status: 503, error: 'browser-preview-unavailable' });
    // A refused start leaves no tab behind: nothing to stop.
    expect(registry.size).toBe(0);
    expect(desktop.commands()).not.toContain('browser.streamStop');
  });
});
