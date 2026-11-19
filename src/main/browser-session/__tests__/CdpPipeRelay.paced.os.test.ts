// The relay's sends on a Windows named pipe: a large message leaves as 64 KiB
// fragments, one write in flight at a time, so the stall watch's drain sign
// (`flushed` rising while something waits) moves as a slow client reads, and
// stays put for a client that stopped. Elsewhere (a Unix socket, TCP) a
// message still leaves whole, as one frame.
//
// The slow client is a real ws client whose bytes the test hands over from the
// pipe CHUNK by CHUNK, so it reads exactly as fast as the test says.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CdpPipeMux, cdpPipeCounters, resetCdpPipeCounters } from '../CdpPipeMux';
import { CdpPipeRelay, RELAY_FRAGMENT_BYTES, RELAY_PATH, type RelayGrant, type RelayOptions } from '../CdpPipeRelay';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

const win32 = process.platform === 'win32';
const CHUNK = 16 << 10;
const relays: CdpPipeRelay[] = [];
const muxes: CdpPipeMux[] = [];
const roots: string[] = [];
const cleanups: Array<() => void> = [];

function testRoot(): string {
  const root = fs.mkdtempSync(path.join(win32 ? (process.env.TEMP ?? '.') : '/tmp', 'wmux-rp-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function setup(opts: RelayOptions = {}, muxOpts: ConstructorParameters<typeof CdpPipeMux>[2] = {}) {
  const relay = new CdpPipeRelay({ roots: win32 ? [] : [testRoot()], ...opts });
  relays.push(relay);
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, muxOpts);
  muxes.push(mux);
  // The drain view the relay hands the mux for each client, as the stall watch reads it.
  const drains: Array<() => { buffered: number; flushed: number }> = [];
  const attach = mux.attachExternal.bind(mux);
  vi.spyOn(mux, 'attachExternal').mockImplementation((label, send, onGone, watched = {}) => {
    if (watched.drain) drains.push(watched.drain);
    return attach(label, send, onGone, watched);
  });
  const route = relay.serve(mux);
  return { relay, browser, mux, route, drains };
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
  for (const relay of relays.splice(0)) await relay.close();
  for (const mux of muxes.splice(0)) mux.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function dial(grant: Pick<RelayGrant, 'endpoint' | 'headers'>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers } });
    cleanups.push(() => ws.terminate());
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
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

/** Resolves once the socket has bytes buffered to read, or has ended. */
function readable(sock: net.Socket): Promise<void> {
  if (sock.readableLength > 0 || sock.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { sock.off('readable', done); sock.off('error', reject); resolve(); };
    sock.once('readable', done);
    sock.once('error', reject);
  });
}

interface Frame { fin: boolean; opcode: number; length: number }

/** Frame headers of the server's (unmasked) frames, as their bytes pass. */
class FrameScan {
  readonly frames: Frame[] = [];
  private head: number[] = [];
  private left = 0;
  feed(buf: Buffer): void {
    let i = 0;
    while (i < buf.length) {
      if (this.left > 0) {
        const n = Math.min(this.left, buf.length - i);
        this.left -= n;
        i += n;
        continue;
      }
      this.head.push(buf[i++]);
      if (this.head.length < 2) continue;
      const len7 = this.head[1] & 0x7f;
      if (this.head.length < 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0)) continue;
      const h = Buffer.from(this.head);
      const length = len7 === 126 ? h.readUInt16BE(2) : len7 === 127 ? Number(h.readBigUInt64BE(2)) : len7;
      this.frames.push({ fin: (h[0] & 0x80) !== 0, opcode: h[0] & 0x0f, length });
      this.head = [];
      this.left = length;
    }
  }
}

/**
 * A ws client that reads only what the test hands it from the pipe. It never
 * answers a ping on its own, so only its reading can show it is alive.
 */
async function slowClient(grant: RelayGrant) {
  const endpoint = grant.endpoint;
  let pipe: net.Socket;
  let url: string;
  if (endpoint.startsWith('ws+unix:')) {
    const rest = endpoint.slice(endpoint.startsWith('ws+unix://') ? 'ws+unix://'.length : 'ws+unix:'.length);
    pipe = net.connect(rest.slice(0, rest.lastIndexOf(`:${RELAY_PATH}`)));
    url = `ws://localhost${RELAY_PATH}`;
  } else {
    pipe = net.connect(Number(new URL(endpoint).port), '127.0.0.1');
    url = endpoint;
  }
  cleanups.push(() => pipe.destroy());
  await new Promise<void>((resolve, reject) => { pipe.once('connect', resolve); pipe.once('error', reject); });
  const feed = new Duplex({
    read() { /* the test pushes */ },
    write(chunk: Buffer, _enc, cb) { pipe.write(chunk, cb); },
    final(cb) { pipe.end(); cb(); },
  });
  const ws = new WebSocket(url, {
    headers: { ...grant.headers },
    createConnection: () => feed as unknown as net.Socket,
    perMessageDeflate: false,
    autoPong: false,
  });
  cleanups.push(() => ws.terminate());
  const errors: string[] = [];
  ws.on('error', (err) => errors.push(err.message));
  const messages: Array<Record<string, unknown>> = [];
  let wake = () => undefined as void;
  let woke = new Promise<void>((resolve) => { wake = resolve; });
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    wake();
    woke = new Promise<void>((resolve) => { wake = resolve; });
  });
  let open = false;
  const opened = new Promise<void>((resolve) => ws.once('open', () => { open = true; resolve(); }));
  const scan = new FrameScan();
  let consumed = 0;
  /** Hands over at most `max` bytes once the pipe has any (or a message came in meanwhile). */
  const step = async (max: number) => {
    await Promise.race([readable(pipe), open ? woke : opened]);
    const n = Math.min(max, pipe.readableLength);
    const got = n > 0 ? (pipe.read(n) as Buffer | null) : null;
    if (!got) return;
    if (open) { consumed += got.length; scan.feed(got); }
    feed.push(got);
  };
  // The handshake answer, handed over whole.
  while (!open) await step(Infinity);
  return {
    ws, pipe, messages, errors, scan,
    get consumed() { return consumed; },
    step,
    /** Hands over everything as it comes until `done` holds. */
    async readUntil(done: () => boolean) { while (!done()) await step(Infinity); },
  };
}

const isConsole = (m: Record<string, unknown>) => m.method === 'Runtime.consoleAPICalled';
const bigEvent = (browser: FakeBrowser, bytes: number) =>
  browser.event('B1', 'Runtime.consoleAPICalled', { args: [{ value: 'x'.repeat(bytes) }] });

describe('CdpPipeRelay: sends on a Windows named pipe', () => {
  it.runIf(win32)('a live slow reader moves the drain sign fragment by fragment, and the watch does not fire', async () => {
    resetCdpPipeCounters();
    const STALL = 400;
    const FRAME = 2 << 20;
    const { browser, route, drains } = await setup({}, { stallMs: STALL });
    const a = await slowClient(await route.grant({}));
    const autoAttach = { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } };
    a.ws.send(JSON.stringify(autoAttach));
    await a.readUntil(() => a.messages.some((m) => m.id === 1));
    const drain = drains[0];
    const b = await dial(await route.grant({}));
    const flushed = [drain().flushed];
    // The backlog first, so it is waiting for `a` when its new target arms the watch.
    bigEvent(browser, FRAME);
    await request(b, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
    expect(cdpPipeCounters().watchdog?.armed).toBeGreaterThanOrEqual(1);

    while (!a.messages.some(isConsole)) {
      flushed.push(drain().flushed);
      await a.step(CHUNK);
      // A live reader that takes 16 KiB at a time, far faster than one per stall period.
      await deliberateSleep(10, 'simulated latency: the pace of a slow but live reader');
    }
    const firedMidMessage = cdpPipeCounters().watchdog?.fired ?? 0;
    const rises = flushed.filter((v, i) => i > 0 && v > flushed[i - 1]).length;
    console.log(`[relayPaced win32] live reads=${flushed.length} rises=${rises} fired=${firedMidMessage} restartedByDrain=${cdpPipeCounters().watchdog?.['restarted-by-drain'] ?? 0}`);
    expect(rises).toBeGreaterThanOrEqual(FRAME / RELAY_FRAGMENT_BYTES - 2);
    expect(firedMidMessage).toBe(0);
    expect(browser.received.some((c) => c.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    expect((a.messages.find(isConsole)?.params as { args: Array<{ value: string }> }).args[0].value).toHaveLength(FRAME);
    expect(a.errors).toEqual([]);
  });

  it.runIf(win32)('a reader that stopped is fired on time, however large the message waiting for it', async () => {
    resetCdpPipeCounters();
    const STALL = 400;
    const { browser, route } = await setup({}, { stallMs: STALL });
    const a = await slowClient(await route.grant({}));
    a.ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
    await a.readUntil(() => a.messages.some((m) => m.id === 1));
    const b = await dial(await route.grant({}));
    bigEvent(browser, 8 << 20);
    const before = a.consumed;
    while (a.consumed < before + (128 << 10)) await a.step(CHUNK);
    const stopped = Date.now();
    await request(b, { id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
    await vi.waitFor(() => expect(browser.received.some((c) => c.method === 'Runtime.runIfWaitingForDebugger')).toBe(true), { timeout: 10_000 });
    const elapsed = Date.now() - stopped;
    console.log(`[relayPaced win32] stopped fireAfterMs=${elapsed} stallMs=${STALL}`);
    expect(elapsed).toBeLessThan(STALL + 1_500);
    expect(a.messages.some(isConsole)).toBe(false);
  });

  it.runIf(win32)('counts what its queue holds toward the per-client cap', async () => {
    const { browser, route } = await setup({ maxBufferedBytes: 256 << 10 });
    const ws = await dial(await route.grant({}));
    await request(ws, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const outcome = new Promise<string>((resolve) => {
      ws.on('message', (data) => { if (isConsole(JSON.parse(data.toString()) as Record<string, unknown>)) resolve('delivered'); });
      ws.once('close', (code) => resolve(`closed ${code}`));
    });
    // One fragment goes to ws; the rest of the 1 MiB waits in the relay's queue.
    bigEvent(browser, 1 << 20);
    expect(await outcome).toBe('closed 1006');
  });

  it.runIf(win32)('counts what its queue holds toward the per-Chrome budget', async () => {
    const { browser, route } = await setup({ maxBufferedBytes: 1 << 30, maxBufferedBytesPerChrome: 256 << 10 });
    const ws = await dial(await route.grant({}));
    await request(ws, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const outcome = new Promise<string>((resolve) => {
      ws.on('message', (data) => { if (isConsole(JSON.parse(data.toString()) as Record<string, unknown>)) resolve('delivered'); });
      ws.once('close', (code) => resolve(`closed ${code}`));
    });
    bigEvent(browser, 1 << 20);
    expect(await outcome).toBe('closed 1006');
  });

  it('keeps messages in order: a small one sent behind a large one arrives after it, both intact', async () => {
    const { browser, route } = await setup();
    const ws = await dial(await route.grant({}));
    await request(ws, { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const got: Array<Record<string, unknown>> = [];
    const both = new Promise<void>((resolve) => ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded') got.push(m);
      if (got.length === 2) resolve();
    }));
    const value = Array.from({ length: 300 << 10 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    browser.event('B1', 'Runtime.consoleAPICalled', { args: [{ value }] });
    browser.event('B1', 'Log.entryAdded', { entry: { text: 'after' } });
    await both;
    expect(got.map((m) => m.method)).toEqual(['Runtime.consoleAPICalled', 'Log.entryAdded']);
    expect((got[0].params as { args: Array<{ value: string }> }).args[0].value).toBe(value);
  });

  it.each<[string, RelayOptions]>([
    ['the relay\'s own transport', {}],
    ['loopback TCP', { windowsPipe: false, roots: [] }],
  ])('a large message on %s: fragments on a Windows named pipe only, one frame elsewhere', async (_name, opts) => {
    const { browser, route } = await setup(opts);
    const grant = await route.grant({});
    const onPipe = win32 && grant.endpoint.startsWith('ws+unix:');
    const a = await slowClient(grant);
    a.ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await a.readUntil(() => a.messages.some((m) => m.id === 1));
    const from = a.scan.frames.length;
    bigEvent(browser, 1 << 20);
    await a.readUntil(() => a.messages.some(isConsole));
    const data = a.scan.frames.slice(from).filter((f) => f.opcode === 0 || f.opcode === 1);
    if (onPipe) {
      expect(data[0]).toEqual({ fin: false, opcode: 1, length: RELAY_FRAGMENT_BYTES });
      expect(data.slice(1, -1).every((f) => !f.fin && f.opcode === 0 && f.length === RELAY_FRAGMENT_BYTES)).toBe(true);
      expect(data.at(-1)).toMatchObject({ fin: true, opcode: 0 });
      expect(data.length).toBeGreaterThanOrEqual((1 << 20) / RELAY_FRAGMENT_BYTES);
    } else {
      expect(data).toHaveLength(1);
      expect(data[0].fin).toBe(true);
      expect(data[0].opcode).toBe(1);
      expect(data[0].length).toBeGreaterThan(1 << 20);
    }
    expect(a.errors).toEqual([]);
  });
});
