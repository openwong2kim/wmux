// The loopback endpoint external clients dial for a Chrome on a pipe: WebSocket
// upgrades at its random path only, nothing else, and it never names itself.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CdpPipeMux, cdpPipeCounters, resetCdpPipeCounters } from '../CdpPipeMux';
import { CdpPipeEndpoint } from '../CdpPipeEndpoint';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

const opened: Array<{ mux: CdpPipeMux; endpoint: CdpPipeEndpoint }> = [];

async function setup(opts: Parameters<typeof CdpPipeEndpoint.open>[1] = {}, muxOpts: ConstructorParameters<typeof CdpPipeMux>[2] = {}) {
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, muxOpts);
  const endpoint = await CdpPipeEndpoint.open(mux, opts);
  opened.push({ mux, endpoint });
  return { browser, mux, endpoint };
}

afterEach(async () => {
  for (const { mux, endpoint } of opened.splice(0)) {
    await endpoint.close();
    mux.close();
  }
  vi.restoreAllMocks();
});

function dial(url: string, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

function request(ws: WebSocket, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.id !== message.id) return;
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

/** The raw HTTP status line a request gets, or 'closed' when the socket is dropped without one. */
function rawStatus(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let got = '';
    socket.on('data', (d) => {
      got += d.toString();
      const end = got.indexOf('\r\n');
      if (end === -1) return;
      resolve(got.slice(0, end));
      socket.destroy();
    });
    socket.on('close', () => resolve('closed'));
    socket.on('error', () => undefined);
  });
}

const upgrade = (path: string, extra = '') =>
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

describe('CdpPipeEndpoint', () => {
  it('serves CDP at a random loopback path, as a client of the mux', async () => {
    const { endpoint } = await setup();
    const url = new URL(endpoint.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toMatch(/^\/devtools\/browser\/[0-9a-f]{64}$/);
    const ws = await dial(endpoint.url);
    expect(await request(ws, { id: 1, method: 'Browser.getVersion' })).toEqual({ id: 1, result: { echo: 'Browser.getVersion' } });
    ws.close();
  });

  it('has no HTTP routes and refuses the wrong path, any Origin, and anything that is not an upgrade', async () => {
    const { endpoint } = await setup();
    const { port, pathname } = new URL(endpoint.url);
    const p = Number(port);
    expect(await rawStatus(p, 'GET /json/version HTTP/1.1\r\nHost: x\r\n\r\n')).toBe('HTTP/1.1 404 Not Found');
    expect(await rawStatus(p, `GET ${pathname} HTTP/1.1\r\nHost: x\r\n\r\n`)).toBe('HTTP/1.1 404 Not Found');
    expect(await rawStatus(p, upgrade('/devtools/browser/guess'))).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawStatus(p, upgrade(`${pathname}x`))).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawStatus(p, upgrade(pathname, 'Origin: http://127.0.0.1\r\n'))).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawStatus(p, upgrade(pathname, 'Origin: null\r\n'))).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawStatus(p, upgrade(pathname))).toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('offers no per-message compression', async () => {
    const { endpoint } = await setup();
    const ws = await dial(endpoint.url, { perMessageDeflate: true });
    expect(ws.extensions).toBe('');
    ws.close();
  });

  it('caps connections', async () => {
    const { endpoint } = await setup({ maxClients: 2 });
    const a = await dial(endpoint.url);
    const b = await dial(endpoint.url);
    await expect(dial(endpoint.url)).rejects.toThrow('HTTP 503');
    a.close();
    await vi.waitFor(async () => { (await dial(endpoint.url)).close(); }, { timeout: 5_000 });
    b.close();
  });

  it('an upgrade that fails its handshake gives its place back', async () => {
    const { endpoint } = await setup({ maxClients: 1 });
    const { port, pathname } = new URL(endpoint.url);
    // No Sec-WebSocket-Key: refused by the handshake itself.
    const bad = `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    expect(await rawStatus(Number(port), bad)).toBe('HTTP/1.1 400 Bad Request');
    await vi.waitFor(async () => { (await dial(endpoint.url)).close(); }, { timeout: 5_000 });
  });

  it('a server error after it is listening is logged, not thrown, and a client sending garbage is dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { endpoint } = await setup();
    const server = (endpoint as unknown as { server: import('node:http').Server }).server;
    expect(() => server.emit('error', new Error('EMFILE'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[CdpPipeEndpoint] server error:', 'EMFILE');
    expect(await rawStatus(Number(new URL(endpoint.url).port), '\x00\x01 not http at all\r\n\r\n')).toBe('closed');
    // Still serving.
    (await dial(endpoint.url)).close();
  });

  it('drops a connection whose headers never finish', async () => {
    const { endpoint } = await setup({ headerTimeoutMs: 200 });
    const started = Date.now();
    expect(await rawStatus(Number(new URL(endpoint.url).port), 'GET / HTTP/1.1\r\nHost: x\r\n')).toMatch(/closed|408/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('disconnects a client that stops reading once too much waits for it', async () => {
    const { browser, endpoint } = await setup({ maxBufferedBytes: 1024 });
    const ws = await dial(endpoint.url);
    await request(ws, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const socket = (ws as unknown as { _socket: net.Socket })._socket;
    socket.pause();
    const big = 'x'.repeat(8 * 1024 * 1024);
    for (let i = 0; i < 4; i++) browser.event('B1', 'Runtime.consoleAPICalled', { args: [{ value: big }] });
    // Read again: the server has already cut the connection, with no close frame.
    await deliberateSleep(300, 'the frames must be sent while the client is not reading');
    socket.resume();
    expect(await closed).toBe(1006);
  });

  it('close() disconnects every client and stops listening', async () => {
    const { endpoint } = await setup();
    const ws = await dial(endpoint.url);
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await endpoint.close();
    await closed;
    await expect(dial(endpoint.url)).rejects.toThrow();
  });

  it('never writes its URL to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const { endpoint } = await setup();
    const ws = await dial(endpoint.url);
    await request(ws, { id: 1, method: 'Browser.getVersion' });
    ws.close();
    await endpoint.close();
    const secret = new URL(endpoint.url).pathname.split('/').pop() as string;
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  });
});

describe('CdpPipeEndpoint: signs of life for the stall watch', () => {
  it('pings a client with a target waiting on it, and its WebSocket\'s pong keeps the target waiting for it', async () => {
    resetCdpPipeCounters();
    const { browser, endpoint } = await setup({}, { stallMs: 100 });
    const a = await dial(endpoint.url);
    const b = await dial(endpoint.url);
    let pings = 0;
    a.on('ping', () => { pings++; });
    await request(a, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    await request(b, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
    // a's WebSocket answers each ping on its own (ws does), and sends nothing else.
    await deliberateSleep(450, 'several stall periods');
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(browser.received.some((c) => c.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    expect(cdpPipeCounters().watchdog?.['restarted-by-pong']).toBeGreaterThanOrEqual(2);
    a.close();
    b.close();
  });
});

