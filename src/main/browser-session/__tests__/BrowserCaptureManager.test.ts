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
