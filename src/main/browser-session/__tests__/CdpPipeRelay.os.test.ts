// The relay external clients dial for every Chrome on a pipe: one exact path,
// a one-time token per connection, checked in a fixed order, and a socket
// nobody else can reach or replace.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CdpPipeMux, cdpPipeCounters, resetCdpPipeCounters, type ClientRef } from '../CdpPipeMux';
import { CdpPipeRelay, RELAY_PATH, type RelayGrant, type RelayOptions } from '../CdpPipeRelay';
import { RELAY_DIR_PREFIX, sweepDeadRelayDirs, verifyRelaySocket } from '../relaySocket';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

const posix = process.platform !== 'win32';
const relays: CdpPipeRelay[] = [];
const muxes: CdpPipeMux[] = [];
const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

/** A private temp root of the test's own, short enough for a socket path. Never the shared temp dir. */
function testRoot(): string {
  const root = fs.mkdtempSync(path.join(posix ? '/tmp' : (process.env.TEMP ?? '.'), 'wmux-rr-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function setup(opts: RelayOptions = {}, muxOpts: ConstructorParameters<typeof CdpPipeMux>[2] = {}) {
  const relay = new CdpPipeRelay({ roots: posix ? [testRoot()] : [], ...opts });
  relays.push(relay);
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, muxOpts);
  muxes.push(mux);
  const route = relay.serve(mux);
  return { relay, browser, mux, route };
}

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const mux of muxes.splice(0)) mux.close();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function dial(grant: RelayGrant, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers }, ...options });
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

/** Where a grant's endpoint listens: a socket path or a loopback port. */
function placeOf(endpoint: string): { path: string } | { port: number } {
  if (endpoint.startsWith('ws+unix://')) return { path: endpoint.slice('ws+unix://'.length, endpoint.lastIndexOf(`:${RELAY_PATH}`)) };
  return { port: Number(new URL(endpoint).port) };
}

/** The raw HTTP status line a request gets, or 'closed' when the socket is dropped without one. */
function rawStatus(endpoint: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    const place = placeOf(endpoint);
    const socket = 'path' in place ? net.connect(place.path, () => socket.write(text)) : net.connect(place.port, '127.0.0.1', () => socket.write(text));
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

const hostOf = (endpoint: string) => ('port' in placeOf(endpoint) ? new URL(endpoint).host : 'localhost');
const upgrade = (endpoint: string, opts: { method?: string; path?: string; host?: string; extra?: string } = {}) =>
  `${opts.method ?? 'GET'} ${opts.path ?? RELAY_PATH} HTTP/1.1\r\nHost: ${opts.host ?? hostOf(endpoint)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${opts.extra ?? ''}\r\n`;
const auth = (grant: RelayGrant) => `Authorization: ${grant.headers.Authorization}\r\n`;

describe('CdpPipeRelay', () => {
  it.skipIf(!posix)('serves CDP on a Unix socket in a private dir, to a client with a token', async () => {
    const { route } = await setup();
    const grant = await route.grant({ workspaceId: 'ws-a' });
    expect(grant.endpoint).toMatch(new RegExp(`^ws\\+unix:///tmp/wmux-rr-[A-Za-z0-9]{6}/${RELAY_DIR_PREFIX}[A-Za-z0-9]{6}/r\\.sock:${RELAY_PATH}$`));
    expect(grant.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    const socketPath = (placeOf(grant.endpoint) as { path: string }).path;
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    const ws = await dial(grant);
    expect(await request(ws, { id: 1, method: 'Browser.getVersion' })).toEqual({ id: 1, result: { echo: 'Browser.getVersion' } });
    ws.close();
  });

  it('falls back to loopback TCP with no usable root, and still needs the token', async () => {
    const { route } = await setup({ roots: [] });
    const grant = await route.grant({});
    expect(grant.endpoint).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:\\d+${RELAY_PATH}$`));
    const ws = await dial(grant);
    expect(await request(ws, { id: 1, method: 'Browser.getVersion' })).toEqual({ id: 1, result: { echo: 'Browser.getVersion' } });
    ws.close();
    await expect(dial({ endpoint: grant.endpoint, headers: { Authorization: 'Bearer nope' } })).rejects.toThrow('HTTP 401');
  });

  it.skipIf(!posix)('skips a root with a non-ASCII or too long path, or one other users can write without the sticky bit', async () => {
    const base = testRoot();
    const nonAscii = path.join(base, '사용자');
    const long = path.join(base, 'a'.repeat(80));
    const open = path.join(base, 'open');
    for (const dir of [nonAscii, long, open]) fs.mkdirSync(dir);
    fs.chmodSync(open, 0o777);
    const good = path.join(base, 'good');
    fs.mkdirSync(good, { mode: 0o700 });
    const { route } = await setup({ roots: [nonAscii, long, open, good] });
    expect((placeOf((await route.grant({})).endpoint) as { path: string }).path.startsWith(`${good}/`)).toBe(true);
    for (const dir of [nonAscii, long, open]) expect(fs.readdirSync(dir)).toEqual([]);

    const tcp = await setup({ roots: [nonAscii, long, open] });
    expect((await tcp.route.grant({})).endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
  });

  it.skipIf(!posix)('takes a socket only while its dir and the socket are this user\'s and closed to everyone else', () => {
    const base = testRoot();
    const dir = path.join(base, 'd');
    fs.mkdirSync(dir, { mode: 0o700 });
    const server = net.createServer();
    const socketPath = path.join(dir, 'r.sock');
    return new Promise<void>((resolve) => server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      expect(verifyRelaySocket({ dir, socketPath })).not.toBeNull();
      fs.chmodSync(dir, 0o750);
      expect(verifyRelaySocket({ dir, socketPath })).toBeNull();
      fs.chmodSync(dir, 0o700);
      fs.chmodSync(socketPath, 0o660);
      expect(verifyRelaySocket({ dir, socketPath })).toBeNull();
      server.close(() => resolve());
    }));
  });

  it('checks an upgrade in order: method and path, Origin, Host on TCP, token; a refusal leaves a good token unspent', async () => {
    for (const roots of posix ? [undefined, []] : [[]]) {
      const { route } = await setup(roots ? { roots } : {});
      const grant = await route.grant({});
      const ep = grant.endpoint;
      expect(await rawStatus(ep, `GET ${RELAY_PATH} HTTP/1.1\r\nHost: ${hostOf(ep)}\r\n${auth(grant)}\r\n`)).toBe('HTTP/1.1 404 Not Found');
      expect(await rawStatus(ep, upgrade(ep, { path: `${RELAY_PATH}x`, extra: auth(grant) }))).toBe('HTTP/1.1 404 Not Found');
      expect(await rawStatus(ep, upgrade(ep, { path: `${RELAY_PATH}?a=1`, extra: auth(grant) }))).toBe('HTTP/1.1 404 Not Found');
      expect(await rawStatus(ep, upgrade(ep, { method: 'POST', extra: auth(grant) }))).toBe('HTTP/1.1 404 Not Found');
      expect(await rawStatus(ep, upgrade(ep, { extra: `Origin: null\r\n${auth(grant)}` }))).toBe('HTTP/1.1 403 Forbidden');
      expect(await rawStatus(ep, upgrade(ep, { extra: `Origin: http://127.0.0.1\r\n${auth(grant)}` }))).toBe('HTTP/1.1 403 Forbidden');
      if ('port' in placeOf(ep)) {
        expect(await rawStatus(ep, upgrade(ep, { host: 'localhost', extra: auth(grant) }))).toBe('HTTP/1.1 403 Forbidden');
        expect(await rawStatus(ep, upgrade(ep, { host: `evil.test:${new URL(ep).port}`, extra: auth(grant) }))).toBe('HTTP/1.1 403 Forbidden');
      }
      expect(await rawStatus(ep, upgrade(ep))).toBe('HTTP/1.1 401 Unauthorized');
      expect(await rawStatus(ep, upgrade(ep, { extra: 'Authorization: Bearer forged\r\n' }))).toBe('HTTP/1.1 401 Unauthorized');
      expect(await rawStatus(ep, upgrade(ep, { extra: `Authorization: ${grant.headers.Authorization.replace('Bearer', 'Basic')}\r\n` }))).toBe('HTTP/1.1 401 Unauthorized');
      // The earliest failing check answers: a bad path with a bad token is a 404.
      expect(await rawStatus(ep, upgrade(ep, { path: '/json/version', extra: 'Authorization: Bearer forged\r\n' }))).toBe('HTTP/1.1 404 Not Found');
      // Every refusal above left the good token unspent; it opens exactly one connection.
      expect(await rawStatus(ep, upgrade(ep, { extra: auth(grant) }))).toBe('HTTP/1.1 101 Switching Protocols');
      expect(await rawStatus(ep, upgrade(ep, { extra: auth(grant) }))).toBe('HTTP/1.1 401 Unauthorized');
    }
  });

  it('caps connections per Chrome; a refusal for room leaves the token usable', async () => {
    const { route } = await setup({ maxClientsPerChrome: 2 });
    const a = await dial(await route.grant({}));
    const b = await dial(await route.grant({}));
    const third = await route.grant({});
    await expect(dial(third)).rejects.toThrow('HTTP 503');
    a.close();
    await vi.waitFor(async () => { (await dial(third)).close(); }, { timeout: 5_000 });
    b.close();
  });

  it('a token reaches only the Chrome it was minted for, and carries the caller\'s identity onto the client', async () => {
    const seen: ClientRef[] = [];
    const relay = new CdpPipeRelay({ roots: posix ? [testRoot()] : [] });
    relays.push(relay);
    const one = new FakeBrowser();
    const two = new FakeBrowser();
    const filter = (client: ClientRef) => { seen.push(client); return null; };
    const muxOne = new CdpPipeMux(one.fromMux, one.toMux, { filter });
    const muxTwo = new CdpPipeMux(two.fromMux, two.toMux);
    muxes.push(muxOne, muxTwo);
    const routeOne = relay.serve(muxOne);
    const routeTwo = relay.serve(muxTwo);
    const toOne = await dial(await routeOne.grant({ workspaceId: 'ws-a', profile: 'p1' }));
    const toTwo = await dial(await routeTwo.grant({ workspaceId: 'ws-b', profile: 'p2' }));
    await request(toOne, { id: 1, method: 'Test.one' });
    await request(toTwo, { id: 1, method: 'Test.two' });
    expect(one.received.map((c) => c.method)).toContain('Test.one');
    expect(one.received.map((c) => c.method)).not.toContain('Test.two');
    expect(two.received.map((c) => c.method)).toContain('Test.two');
    expect(seen.find((c) => c.kind === 'external')?.identity).toEqual({ workspaceId: 'ws-a', profile: 'p1' });
    toOne.close();
    toTwo.close();
  });

  it('a client cannot drive another client\'s session by naming its id', async () => {
    const { route } = await setup();
    const a = await dial(await route.grant({ workspaceId: 'ws-a' }));
    const b = await dial(await route.grant({ workspaceId: 'ws-b' }));
    const attached = new Promise<string>((resolve) => a.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { method?: string; params?: { sessionId?: string } };
      if (frame.method === 'Target.attachedToTarget' && frame.params?.sessionId) resolve(frame.params.sessionId);
    }));
    await request(a, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
    await request(b, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
    const session = await attached;
    const bFrames: string[] = [];
    b.on('message', (data) => bFrames.push(data.toString()));
    expect((await request(a, { id: 2, method: 'Runtime.evaluate', params: { expression: 'x' }, sessionId: session })).result).toBeDefined();
    expect((await request(b, { id: 2, method: 'Runtime.evaluate', params: { expression: 'x' }, sessionId: session })).error).toEqual({ code: -32001, message: 'Session with given id not found.' });
    expect(bFrames.some((f) => f.includes(session))).toBe(false);
    a.close();
    b.close();
  });

  it('when a Chrome goes, its clients are disconnected and its unused tokens refused', async () => {
    const { route } = await setup();
    const ws = await dial(await route.grant({}));
    const unused = await route.grant({});
    const closed = new Promise((resolve) => ws.once('close', resolve));
    route.close();
    await closed;
    await expect(dial(unused)).rejects.toThrow('HTTP 401');
    await expect(route.grant({})).rejects.toThrow('that Chrome is gone');
  });

  it.skipIf(!posix)('binds afresh when its socket is removed, keeping the connections it has; one bind for concurrent grants', async () => {
    const { route } = await setup();
    const first = await route.grant({});
    const ws = await dial(first);
    const socketPath = (placeOf(first.endpoint) as { path: string }).path;
    fs.rmSync(socketPath);
    const [g1, g2] = await Promise.all([route.grant({}), route.grant({})]);
    expect(g1.endpoint).not.toBe(first.endpoint);
    expect(g2.endpoint).toBe(g1.endpoint);
    (await dial(g1)).close();
    (await dial(g2)).close();
    // The connection made before is still served.
    expect(await request(ws, { id: 7, method: 'Browser.getVersion' })).toEqual({ id: 7, result: { echo: 'Browser.getVersion' } });
    // The old dir went with the old socket.
    expect(fs.existsSync(path.dirname(socketPath))).toBe(false);
    ws.close();
  });

  it('offers no per-message compression', async () => {
    const { route } = await setup();
    const ws = await dial(await route.grant({}), { perMessageDeflate: true });
    expect(ws.extensions).toBe('');
    ws.close();
  });

  it('an upgrade that fails its handshake gives its place back, and spends its token', async () => {
    const { route } = await setup({ maxClientsPerChrome: 1 });
    const grant = await route.grant({});
    // No Sec-WebSocket-Key: refused by the handshake itself.
    const bad = `GET ${RELAY_PATH} HTTP/1.1\r\nHost: ${hostOf(grant.endpoint)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n${auth(grant)}\r\n`;
    expect(await rawStatus(grant.endpoint, bad)).toBe('HTTP/1.1 400 Bad Request');
    await expect(dial(grant)).rejects.toThrow('HTTP 401');
    await vi.waitFor(async () => { (await dial(await route.grant({}))).close(); }, { timeout: 5_000 });
  });

  it('a server error after it is listening is logged, not thrown, and a client sending garbage is dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { relay, route } = await setup();
    const grant = await route.grant({});
    const server = (relay as unknown as { listener: { server: import('node:http').Server } }).listener.server;
    expect(() => server.emit('error', new Error('EMFILE'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[CdpPipeRelay] server error:', 'EMFILE');
    expect(await rawStatus(grant.endpoint, '\x00\x01 not http at all\r\n\r\n')).toBe('closed');
    (await dial(grant)).close();
  });

  it('drops a connection whose headers never finish', async () => {
    const { route } = await setup({ headerTimeoutMs: 200 });
    const grant = await route.grant({});
    const started = Date.now();
    expect(await rawStatus(grant.endpoint, 'GET / HTTP/1.1\r\nHost: x\r\n')).toMatch(/closed|408/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('disconnects a client that stops reading once too much waits for it', async () => {
    const { browser, route } = await setup({ maxBufferedBytes: 1024 });
    const ws = await dial(await route.grant({}));
    await request(ws, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const socket = (ws as unknown as { _socket: net.Socket })._socket;
    socket.pause();
    const big = 'x'.repeat(8 * 1024 * 1024);
    for (let i = 0; i < 4; i++) browser.event('B1', 'Runtime.consoleAPICalled', { args: [{ value: big }] });
    await deliberateSleep(300, 'the frames must be sent while the client is not reading');
    socket.resume();
    expect(await closed).toBe(1006);
  });

  it('close() disconnects every client, stops listening and removes its socket dir', async () => {
    const { relay, route } = await setup();
    const grant = await route.grant({});
    const ws = await dial(grant);
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await relay.close();
    await closed;
    await expect(dial(grant)).rejects.toThrow();
    const place = placeOf(grant.endpoint);
    if ('path' in place) expect(fs.existsSync(path.dirname(place.path))).toBe(false);
  });

  it('Playwright refused by the relay, for a wrong token or for room, gets an error that names no token', async () => {
    const { chromium } = await import('playwright-core');
    const { route } = await setup({ maxClientsPerChrome: 1 });
    const held = await dial(await route.grant({}));
    const grant = await route.grant({});
    const token = grant.headers.Authorization.slice('Bearer '.length);
    const refused = async (headers: Record<string, string>) => {
      const err = await chromium.connectOverCDP(grant.endpoint, { headers, timeout: 5_000 }).then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      return (err as Error).message;
    };
    const wrong = await refused({ Authorization: 'Bearer forged-token-value' });
    const noRoom = await refused({ ...grant.headers });
    expect(wrong).toMatch(/401/);
    expect(noRoom).toMatch(/503/);
    for (const message of [wrong, noRoom]) {
      expect(message).not.toContain('forged-token-value');
      expect(message).not.toContain(token);
    }
    held.close();
  });

  it('never writes its endpoint or a token to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const { relay, route } = await setup();
    const grant = await route.grant({});
    const ws = await dial(grant);
    await request(ws, { id: 1, method: 'Browser.getVersion' });
    await rawStatus(grant.endpoint, upgrade(grant.endpoint, { extra: 'Authorization: Bearer forged\r\n' }));
    ws.close();
    await relay.close();
    const token = grant.headers.Authorization.slice('Bearer '.length);
    const where = 'path' in placeOf(grant.endpoint) ? (placeOf(grant.endpoint) as { path: string }).path : grant.endpoint;
    for (const spy of spies) for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
      expect(JSON.stringify(call)).not.toContain(where);
    }
  });
});

describe.skipIf(!posix)('CdpPipeRelay: leftover socket dirs', () => {
  /** A pid that no longer runs: a child that has exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    return child.pid as number;
  }

  /** A pid that runs until the test ends. */
  async function livePid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); console.log("up")'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    await new Promise((resolve) => child.stdout?.once('data', resolve));
    return child.pid as number;
  }

  function leftover(root: string, suffix: string, pid: number | null): string {
    const dir = path.join(root, `${RELAY_DIR_PREFIX}${suffix}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    if (pid !== null) fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify({ pid }));
    return dir;
  }

  it('removes only a dir whose owner is gone and whose socket nobody accepts on', async () => {
    const root = testRoot();
    const dead = await deadPid();
    const live = await livePid();
    const gone = leftover(root, 'gone01', dead);
    const deadButServed = leftover(root, 'serve1', dead);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(deadButServed, 'r.sock'), resolve));
    const alive = leftover(root, 'alive1', live);
    const mine = leftover(root, 'mine01', process.pid);
    const unowned = leftover(root, 'nown01', null);
    const notOurs = path.join(root, 'other-dir');
    fs.mkdirSync(notOurs);
    fs.writeFileSync(path.join(notOurs, 'owner'), JSON.stringify({ pid: dead }));
    fs.symlinkSync(notOurs, path.join(root, `${RELAY_DIR_PREFIX}link01`));

    expect(await sweepDeadRelayDirs(root)).toEqual([gone]);
    for (const dir of [deadButServed, alive, mine, unowned, notOurs]) expect(fs.existsSync(dir)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
  });

  it('a second instance starting on the same root leaves the first one\'s socket and connections alone, and sweeps a dead one', async () => {
    const root = testRoot();
    const a = await setup({ roots: [root] });
    const grantA = await a.route.grant({});
    const wsA = await dial(grantA);
    const dirA = path.dirname((placeOf(grantA.endpoint) as { path: string }).path);
    // As if A were another process that is still running.
    fs.writeFileSync(path.join(dirA, 'owner'), JSON.stringify({ pid: await livePid() }));
    const dead = leftover(root, 'dead01', await deadPid());

    const b = await setup({ roots: [root] });
    const grantB = await b.route.grant({});
    expect(grantB.endpoint).not.toBe(grantA.endpoint);
    await b.relay.sweeping;
    expect(fs.existsSync(dead)).toBe(false);
    expect(verifyRelaySocket({ dir: dirA, socketPath: path.join(dirA, 'r.sock') })).not.toBeNull();
    expect(await request(wsA, { id: 3, method: 'Browser.getVersion' })).toEqual({ id: 3, result: { echo: 'Browser.getVersion' } });
    (await dial(await a.route.grant({}))).close();
    (await dial(grantB)).close();
    wsA.close();
  });
});

describe('CdpPipeRelay: signs of life for the stall watch', () => {
  it('pings a client with a target waiting on it, and its WebSocket\'s pong keeps the target waiting for it', async () => {
    resetCdpPipeCounters();
    const { browser, route } = await setup({}, { stallMs: 100 });
    const a = await dial(await route.grant({}));
    const b = await dial(await route.grant({}));
    let pings = 0;
    a.on('ping', () => { pings++; });
    await request(a, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
    await request(b, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
    await deliberateSleep(450, 'several stall periods');
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(browser.received.some((c) => c.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    expect(cdpPipeCounters().watchdog?.['restarted-by-pong']).toBeGreaterThanOrEqual(2);
    a.close();
    b.close();
  });
});
