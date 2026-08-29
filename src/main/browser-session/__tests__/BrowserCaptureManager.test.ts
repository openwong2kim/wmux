/* eslint-disable @typescript-eslint/no-non-null-assertion -- fakeWc is set in
   beforeEach; non-null assertions keep the controlled-fake tests readable. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Controllable fake webContents/debugger, swapped per test.
let fakeWc: FakeWc | null;

vi.mock('electron', () => ({
  webContents: { fromId: () => fakeWc },
}));

import { BrowserCaptureManager } from '../BrowserCaptureManager';

interface FakeDbg extends EventEmitter {
  isAttached: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  __body?: { body: string; base64Encoded: boolean };
}
interface FakeWc extends EventEmitter {
  isDestroyed: () => boolean;
  debugger: FakeDbg;
}

function makeFakeWc(): FakeWc {
  const dbg = new EventEmitter() as FakeDbg;
  dbg.isAttached = vi.fn(() => true);
  dbg.attach = vi.fn();
  dbg.sendCommand = vi.fn(async (method: string) => {
    if (method === 'Network.getResponseBody') {
      return dbg.__body ?? { body: '', base64Encoded: false };
    }
    return {};
  });
  const wc = new EventEmitter() as FakeWc;
  wc.isDestroyed = () => false;
  wc.debugger = dbg;
  return wc;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function emit(wc: FakeWc, method: string, params: unknown) {
  wc.debugger.emit('message', {}, method, params);
}

describe('BrowserCaptureManager', () => {
  let mgr: BrowserCaptureManager;

  beforeEach(() => {
    fakeWc = makeFakeWc();
    mgr = new BrowserCaptureManager();
  });

  it('enables Runtime + Network with buffer sizes and attaches one message listener (C1)', async () => {
    const state = await mgr.ensure(1);
    expect(state).not.toBeNull();
    const cmds = fakeWc!.debugger.sendCommand.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('Runtime.enable');
    expect(cmds).toContain('Network.enable');
    const netEnable = fakeWc!.debugger.sendCommand.mock.calls.find((c) => c[0] === 'Network.enable');
    expect(netEnable?.[1]).toMatchObject({ maxResourceBufferSize: expect.any(Number), maxTotalBufferSize: expect.any(Number) });
    expect(fakeWc!.debugger.listenerCount('message')).toBe(1);
  });

  it('singleflight: concurrent first calls attach the listener once (C2)', async () => {
    await Promise.all([mgr.ensure(1), mgr.ensure(1), mgr.ensure(1)]);
    expect(fakeWc!.debugger.listenerCount('message')).toBe(1);
    const enables = fakeWc!.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Runtime.enable');
    expect(enables).toHaveLength(1);
  });

  it('formats console RemoteObjects and maps warning -> warn (C5)', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }],
    });
    emit(fakeWc!, 'Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'object', description: 'Error: boom' }],
    });
    emit(fakeWc!, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'undefined' }, { type: 'object', unserializableValue: 'NaN' }],
    });
    const c = mgr.getConsole(1);
    expect(c).toEqual([
      { level: 'warn', text: 'hello 42' },
      { level: 'error', text: 'Error: boom' },
      { level: 'log', text: 'undefined NaN' },
    ]);
  });

  it('correlates network by requestId and exposes summaries (C6)', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x.test/a', method: 'GET' },
    });
    emit(fakeWc!, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, headers: { 'Content-Type': 'application/json' } },
    });
    const net = mgr.getNetwork(1);
    expect(net).toEqual([{ url: 'https://x.test/a', method: 'GET', status: 200 }]);
  });

  it('captures + base64-decodes a textual response body on loadingFinished (C7)', async () => {
    await mgr.ensure(1);
    fakeWc!.debugger.__body = { body: Buffer.from('{"ok":true}').toString('base64'), base64Encoded: true };
    emit(fakeWc!, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x.test/api', method: 'GET' } });
    emit(fakeWc!, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    emit(fakeWc!, 'Network.loadingFinished', { requestId: 'r1' });
    await tick();
    expect(mgr.getResponseBody(1, '*api*')).toBe('{"ok":true}');
    expect(mgr.getResponseBody(1, '*nomatch*')).toBeNull();
  });

  it('does not fetch a body for non-textual responses', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x.test/img.png', method: 'GET' } });
    emit(fakeWc!, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'content-type': 'image/png' } } });
    emit(fakeWc!, 'Network.loadingFinished', { requestId: 'r1' });
    await tick();
    expect(fakeWc!.debugger.sendCommand.mock.calls.some((c) => c[0] === 'Network.getResponseBody')).toBe(false);
    expect(mgr.getResponseBody(1, '*img*')).toBeNull();
  });

  it('survives a getResponseBody rejection without poisoning capture (C7)', async () => {
    await mgr.ensure(1);
    fakeWc!.debugger.sendCommand.mockImplementationOnce(async () => ({})); // Runtime.enable
    // make getResponseBody reject
    fakeWc!.debugger.sendCommand.mockImplementation(async (m: string) => {
      if (m === 'Network.getResponseBody') throw new Error('evicted');
      return {};
    });
    emit(fakeWc!, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x.test/api', method: 'GET' } });
    emit(fakeWc!, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    emit(fakeWc!, 'Network.loadingFinished', { requestId: 'r1' });
    await tick();
    expect(mgr.getResponseBody(1, '*api*')).toBeNull();
    expect(mgr.getNetwork(1)).toEqual([{ url: 'https://x.test/api', method: 'GET', status: 200 }]);
  });

  it('records redirect hops and correlates the final response by reused requestId (C6)', async () => {
    await mgr.ensure(1);
    // CDP reuses the requestId across a redirect chain.
    emit(fakeWc!, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x.test/a', method: 'GET' } });
    emit(fakeWc!, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x.test/b', method: 'GET' },
      redirectResponse: { status: 301, headers: { location: '/b' } },
    });
    emit(fakeWc!, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: {} } });
    const net = mgr.getNetwork(1);
    expect(net).toEqual([
      { url: 'https://x.test/a', method: 'GET', status: 301 }, // redirect hop preserved
      { url: 'https://x.test/b', method: 'GET', status: 200 }, // final correlates
    ]);
  });

  it('truncates a large body by UTF-8 bytes (C7)', async () => {
    await mgr.ensure(1);
    const big = 'x'.repeat(300 * 1024); // > 256KB cap
    fakeWc!.debugger.__body = { body: big, base64Encoded: false };
    emit(fakeWc!, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x.test/big.json', method: 'GET' } });
    emit(fakeWc!, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    emit(fakeWc!, 'Network.loadingFinished', { requestId: 'r1' });
    await tick();
    const body = mgr.getResponseBody(1, '*big*');
    expect(body).not.toBeNull();
    expect(body).toContain('truncated');
    expect(body).toContain('bytes');
    // retained bytes are bounded by the per-body cap (+ the short suffix)
    expect(Buffer.byteLength(body!, 'utf8')).toBeLessThan(256 * 1024 + 100);
  });

  it('clear empties the respective buffer', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x' }] });
    emit(fakeWc!, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'u', method: 'GET' } });
    expect(mgr.getConsole(1)).toHaveLength(1);
    expect(mgr.getNetwork(1)).toHaveLength(1);
    mgr.clearConsole(1);
    mgr.clearNetwork(1);
    expect(mgr.getConsole(1)).toHaveLength(0);
    expect(mgr.getNetwork(1)).toHaveLength(0);
  });

  it('drop removes listeners and forgets the buffer (C3)', async () => {
    await mgr.ensure(1);
    expect(fakeWc!.debugger.listenerCount('message')).toBe(1);
    expect(fakeWc!.debugger.listenerCount('detach')).toBe(1);
    mgr.drop(1);
    expect(fakeWc!.debugger.listenerCount('message')).toBe(0);
    expect(fakeWc!.debugger.listenerCount('detach')).toBe(0);
    expect(mgr.getConsole(1)).toEqual([]);
  });

  it('debugger detach (e.g. DevTools opened) drops capture (C4)', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x' }] });
    expect(mgr.getConsole(1)).toHaveLength(1);
    fakeWc!.debugger.emit('detach');
    expect(mgr.getConsole(1)).toEqual([]);
    expect(fakeWc!.debugger.listenerCount('message')).toBe(0);
  });

  it('returns null when the webContents is gone', async () => {
    fakeWc = null;
    expect(await mgr.ensure(99)).toBeNull();
  });

  it('caps console entries at the ring limit', async () => {
    await mgr.ensure(1);
    for (let i = 0; i < 1100; i++) {
      emit(fakeWc!, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'number', value: i }] });
    }
    const c = mgr.getConsole(1);
    expect(c.length).toBe(1000);
    // oldest dropped: first retained is entry 100
    expect(c[0].text).toBe('100');
    expect(c[c.length - 1].text).toBe('1099');
  });
});

// Lifecycle capture + drain (Phase 1 browser events). Reuses the same fake
// webContents/debugger harness as the suites above.
describe('BrowserCaptureManager lifecycle', () => {
  let mgr: BrowserCaptureManager;

  beforeEach(() => {
    fakeWc = makeFakeWc();
    mgr = new BrowserCaptureManager();
  });

  it('enables the Page domain alongside Runtime + Network', async () => {
    await mgr.ensure(1);
    const cmds = fakeWc!.debugger.sendCommand.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('Page.enable');
    // Order guard: Page.enable must not displace the existing enables.
    expect(cmds).toContain('Runtime.enable');
    expect(cmds).toContain('Network.enable');
  });

  it('records main-frame navigations only, collapses consecutive dupes, and drains destructively', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Page.frameNavigated', { frame: { url: 'https://a.test/' } });
    emit(fakeWc!, 'Page.frameNavigated', { frame: { url: 'https://a.test/' } }); // dupe → collapsed
    emit(fakeWc!, 'Page.frameNavigated', { frame: { parentId: 'f1', url: 'https://ad.test/' } }); // subframe → ignored
    emit(fakeWc!, 'Page.loadEventFired', {});
    emit(fakeWc!, 'Page.frameNavigated', { frame: { url: 'https://b.test/' } });

    const drained = mgr.drainLifecycle(1);
    expect(drained.map((e) => [e.type, e.url])).toEqual([
      ['navigated', 'https://a.test/'],
      ['loaded', undefined],
      ['navigated', 'https://b.test/'],
    ]);
    // Destructive: a second drain reports nothing.
    expect(mgr.drainLifecycle(1)).toEqual([]);
  });

  it('caps the lifecycle ring', async () => {
    await mgr.ensure(1);
    for (let i = 0; i < 30; i++) {
      emit(fakeWc!, 'Page.frameNavigated', { frame: { url: `https://x.test/${i}` } });
    }
    const drained = mgr.drainLifecycle(1);
    expect(drained.length).toBe(20);
    expect(drained[0].url).toBe('https://x.test/10');
  });

  it('drop({closed:true}) preserves undrained events plus a closed record, drained exactly once', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Page.frameNavigated', { frame: { url: 'https://a.test/' } });
    fakeWc!.emit('destroyed'); // wc destroyed → drop with closed:true

    const drained = mgr.drainLifecycle(1);
    expect(drained.map((e) => e.type)).toEqual(['navigated', 'closed']);
    expect(mgr.drainLifecycle(1)).toEqual([]);
  });

  // --- collection window (#1081) ---

  it('reports when collection started, and no gap for a guest that is still blank', async () => {
    (fakeWc as unknown as { getURL: () => string }).getURL = () => 'about:blank';
    const before = Date.now();
    await mgr.ensure(1);

    const window = mgr.getConsoleWindow(1);
    expect(window?.since).toBeGreaterThanOrEqual(before);
    // The eager path enables capture at did-attach, before the page loads.
    expect(window?.missedBefore).toBe(false);
    expect(mgr.getNetworkWindow(1)?.missedBefore).toBe(false);
  });

  it('admits a gap when capture starts on a guest that already shows a page', async () => {
    (fakeWc as unknown as { getURL: () => string }).getURL = () => 'https://x.test/loaded-already';
    await mgr.ensure(1);

    expect(mgr.getConsoleWindow(1)?.missedBefore).toBe(true);
    expect(mgr.getNetworkWindow(1)?.missedBefore).toBe(true);
  });

  it('clearing one buffer restarts only that window', async () => {
    (fakeWc as unknown as { getURL: () => string }).getURL = () => 'https://x.test/loaded-already';
    await mgr.ensure(1);
    const networkSince = mgr.getNetworkWindow(1)?.since;

    mgr.clearConsole(1);

    expect(mgr.getConsoleWindow(1)?.missedBefore).toBe(false);
    expect(mgr.getNetworkWindow(1)?.missedBefore).toBe(true);
    expect(mgr.getNetworkWindow(1)?.since).toBe(networkSince);
  });

  it('stops claiming a pre-attach gap once the main frame navigates away', async () => {
    (fakeWc as unknown as { getURL: () => string }).getURL = () => 'https://x.test/loaded-already';
    await mgr.ensure(1);
    expect(mgr.getConsoleWindow(1)?.missedBefore).toBe(true);

    emit(fakeWc!, 'Page.frameNavigated', { frame: { url: 'https://x.test/somewhere-new' } });

    // The document whose early life went unrecorded is gone; the buffer covers
    // the new one completely, so the footnote would now be misleading.
    expect(mgr.getConsoleWindow(1)?.missedBefore).toBe(false);
    expect(mgr.getNetworkWindow(1)?.missedBefore).toBe(false);
  });

  it('a subframe or same-document navigation does NOT retire the gap', async () => {
    (fakeWc as unknown as { getURL: () => string }).getURL = () => 'https://x.test/loaded-already';
    await mgr.ensure(1);

    emit(fakeWc!, 'Page.frameNavigated', { frame: { parentId: 'f1', url: 'https://ad.test/' } });
    emit(fakeWc!, 'Page.navigatedWithinDocument', { url: 'https://x.test/loaded-already#tab2' });

    // Same document, so the window it could not see is still on screen.
    expect(mgr.getConsoleWindow(1)?.missedBefore).toBe(true);
  });

  it('records an uncaught exception with its stack (#1081)', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: {
          type: 'object',
          subtype: 'error',
          description: 'Error: boom during load\n    at http://x.test/app.js:1:1',
        },
      },
    });

    // An uncaught exception is not a consoleAPICalled event, so it needs its
    // own case - and it is the case #1081 exists for.
    expect(mgr.getConsole(1)).toHaveLength(1);
    expect(mgr.getConsole(1)[0].level).toBe('error');
    expect(mgr.getConsole(1)[0].text).toContain('Uncaught Error: boom during load');
    expect(mgr.getConsole(1)[0].text).toContain('app.js:1:1');
  });

  it('caps a pathological exception stack like any other console line', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'x'.repeat(50_000) } },
    });

    expect(mgr.getConsole(1)[0].text.length).toBeLessThan(5000);
  });

  it('skips the body of a stream that never ends', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Network.requestWillBeSent', {
      requestId: 'sse',
      request: { url: 'https://x.test/events', method: 'GET' },
    });
    emit(fakeWc!, 'Network.responseReceived', {
      requestId: 'sse',
      response: { status: 200, headers: { 'content-type': 'text/event-stream' }, mimeType: 'text/event-stream' },
    });
    emit(fakeWc!, 'Network.loadingFinished', { requestId: 'sse' });
    await tick();

    // getResponseBody on a live stream answers only when the stream closes.
    const bodyCalls = fakeWc!.debugger.sendCommand.mock.calls.filter(
      (c) => c[0] === 'Network.getResponseBody',
    );
    expect(bodyCalls).toHaveLength(0);
    // The request is still listed - only its body is skipped.
    expect(mgr.getNetwork(1)[0]).toMatchObject({ url: 'https://x.test/events', status: 200 });
  });

  it('caps a lifecycle URL like every other captured string', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Page.frameNavigated', { frame: { url: 'data:text/html,' + 'z'.repeat(50_000) } });

    const drained = mgr.drainLifecycle(1);
    expect(drained[0].url?.length).toBeLessThan(3000);
  });

  it('reports no window for a guest nothing is capturing', () => {
    expect(mgr.getConsoleWindow(99)).toBeUndefined();
    expect(mgr.getNetworkWindow(99)).toBeUndefined();
  });

  it('caps one oversized console line and one oversized URL', async () => {
    await mgr.ensure(1);
    emit(fakeWc!, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'x'.repeat(50_000) }],
    });
    emit(fakeWc!, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x.test/' + 'y'.repeat(50_000), method: 'GET' },
    });

    expect(mgr.getConsole(1)[0].text.length).toBeLessThan(5000);
    expect(mgr.getConsole(1)[0].text).toContain('[truncated');
    expect(mgr.getNetwork(1)[0].url.length).toBeLessThan(3000);
  });
  it('a plain drop (debugger detach) does NOT synthesize a closed record', async () => {
    await mgr.ensure(1);
    fakeWc!.debugger.emit('detach'); // DevTools stole the session — guest still alive
    expect(mgr.drainLifecycle(1)).toEqual([]);
  });
});
