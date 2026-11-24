import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { listenNativePipe, loadNativePipe, type NativePipeModule, type NativePipeServer } from '../nativePipe';
import type { NativePipeSocket } from '../nativePipeSocket';
import { deliberateSleep } from '../../test-utils/waitFor';

// The adapter over the built native pipe listener (core/wmux-term,
// pipe-listener-v1): real pipes, real clients. Run by CI's Windows
// integration job with the module built; elsewhere it skips when the module
// or the capability is absent.
let pipe: NativePipeModule | null = null;
if (process.platform === 'win32') {
  try {
    pipe = loadNativePipe();
  } catch (error) {
    if (process.env.WMUX_REQUIRE_RUST_CORE === '1') throw error;
  }
}

const noop = (): void => undefined;
let serial = 0;
const pipeName = () => `\\\\.\\pipe\\wmux-test-native-pipe-${process.pid}-${++serial}`;
const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const pattern = (size: number, seed: number) => {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

const servers: NativePipeServer[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const s of servers.splice(0)) s.close();
});

/** A listener whose accepted sockets arrive through `next()`. */
function listen(name = pipeName(), maxInstances = 8) {
  const queue: NativePipeSocket[] = [];
  const waiters: Array<(s: NativePipeSocket) => void> = [];
  const server = listenNativePipe(name, {
    maxInstances,
    onConnection: (socket) => {
      cleanups.push(() => socket.destroy());
      const waiter = waiters.shift();
      if (waiter) waiter(socket); else queue.push(socket);
    },
  });
  servers.push(server);
  const next = () => new Promise<NativePipeSocket>((resolve) => {
    const ready = queue.shift();
    if (ready) resolve(ready); else waiters.push(resolve);
  });
  return { name, server, next };
}

function connect(name: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.connect(name, () => resolve(client));
    client.once('error', reject);
    cleanups.push(() => client.destroy());
  });
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

const closed = (s: NodeJS.EventEmitter & { closed?: boolean }) =>
  new Promise<void>((resolve) => { if (s.closed) resolve(); else s.once('close', () => resolve()); });

// A client in its own process that reads with small blocking reads and a pause
// after each, so it stays behind the server's writes; it prints the length and
// hash of what it got, how the stream ended, and when.
const SLOW_CLIENT = `
const fs = require('fs'), crypto = require('crypto');
const [name, size, delay] = process.argv.slice(1);
const fd = fs.openSync(name, 'r+');
fs.writeSync(fd, 'hello\\n');
const hash = crypto.createHash('sha256');
const buf = Buffer.alloc(Number(size));
const pause = new Int32Array(new SharedArrayBuffer(4));
let total = 0, end = 'eof';
for (;;) {
  let n;
  try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) { end = e.code || String(e); break; }
  if (n === 0) break;
  hash.update(buf.subarray(0, n));
  total += n;
  Atomics.wait(pause, 0, 0, Number(delay));
}
process.stdout.write(JSON.stringify({ total, sha256: hash.digest('hex'), end, endAt: Date.now() }));
`;

function slowClient(name: string, readSize: number, delayMs: number) {
  const child = spawn(process.execPath, ['-e', SLOW_CLIENT, name, String(readSize), String(delayMs)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  cleanups.push(() => { if (child.exitCode === null) child.kill(); });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  const result = new Promise<{ total: number; sha256: string; end: string; endAt: number }>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code !== 0 || !out) reject(new Error(`slow client exited ${code}: ${err}`));
      else resolve(JSON.parse(out) as { total: number; sha256: string; end: string; endAt: number });
    });
  });
  return { result };
}

async function firstLine(socket: NativePipeSocket): Promise<{ line: string; rest: Buffer }> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) return;
      socket.removeListener('data', onData);
      socket.pause();
      resolve({ line: buffer.subarray(0, nl).toString(), rest: buffer.subarray(nl + 1) });
    };
    socket.on('data', onData);
  });
}

describe.runIf(pipe)('native pipe listener through NativePipeSocket', () => {
  it('a second listener on the same name is refused with EADDRINUSE', () => {
    const { name } = listen();
    let error: unknown;
    try {
      servers.push(listenNativePipe(name, { maxInstances: 1, onConnection: noop }));
    } catch (e) {
      error = e;
    }
    expect((error as NodeJS.ErrnoException | undefined)?.code).toBe('EADDRINUSE');
  });

  it('exposes the peer: this process, this session, this user', async () => {
    const { name, next } = listen();
    await connect(name);
    const socket = await next();
    expect(socket.peer.pid).toBe(process.pid);
    expect(socket.peer.sameSession).toBe(true);
    expect(socket.peer.sameUser).toBe(true);
    expect(socket.peer.integrityRid).toBeGreaterThanOrEqual(0x2000);
    expect(socket.peer.reason).toBeNull();
  });

  it('bytes glued to the first line arrive intact after pause, unshift and resume', async () => {
    const { name, next } = listen();
    const client = await connect(name);
    const body = Buffer.concat([pattern(100_000, 7), Buffer.from('\n')]);
    client.write(Buffer.concat([Buffer.from('{"wmuxShim":1}\n'), body]));
    const socket = await next();
    const { line, rest } = await firstLine(socket);
    expect(line).toBe('{"wmuxShim":1}');
    // A later listener, attached while paused, sees nothing before resume().
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    await deliberateSleep(50, 'a negative check: nothing flows before resume()');
    expect(chunks).toEqual([]);
    socket.unshift(rest);
    socket.resume();
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBe(body.length), { timeout: 10_000 });
    expect(sha256(Buffer.concat(chunks))).toBe(sha256(body));
  });

  it('moves 12 MB each way with backpressure on both sides', async () => {
    const { name, next } = listen();
    const client = await connect(name);
    const socket = await next();
    const size = 12 * 1024 * 1024;

    // Server to client: write() returns false and 'drain' follows.
    const down = pattern(size, 1);
    const received = readAll(client);
    let sawFalse = 0;
    let drains = 0;
    socket.on('drain', () => { drains++; });
    for (let off = 0; off < size; off += 256 * 1024) {
      if (!socket.write(down.subarray(off, off + 256 * 1024))) {
        sawFalse++;
        await new Promise((r) => socket.once('drain', r));
      }
    }
    expect(sawFalse).toBeGreaterThan(0);
    expect(drains).toBeGreaterThan(0);

    // Client to server: flowing until bytes arrive, then paused. The socket's
    // buffer stays bounded (the native side reads only on demand), nothing
    // more arrives while paused, and the client backs up.
    const up = pattern(size, 2);
    const chunks: Buffer[] = [];
    const count = () => chunks.reduce((n, c) => n + c.length, 0);
    let pausedOnce = false;
    socket.on('data', (c: Buffer) => {
      chunks.push(c);
      if (!pausedOnce && count() >= 1024 * 1024) {
        pausedOnce = true;
        socket.pause();
      }
    });
    client.write(up);
    await vi.waitFor(() => expect(socket.isPaused()).toBe(true), { timeout: 10_000 });
    await deliberateSleep(300, 'the client backs up against the paused server; nothing to wait for');
    const whilePaused = count();
    expect(socket.readableLength).toBeLessThanOrEqual(socket.readableHighWaterMark + 2 * 64 * 1024);
    await deliberateSleep(300, 'a negative check: no data events while paused');
    expect(count()).toBe(whilePaused);
    expect(socket.readableLength).toBeLessThanOrEqual(socket.readableHighWaterMark + 2 * 64 * 1024);
    expect(whilePaused).toBeLessThan(size);
    expect(client.writableLength).toBeGreaterThan(0);
    socket.resume();
    await vi.waitFor(() => expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(size), { timeout: 30_000 });
    expect(sha256(Buffer.concat(chunks))).toBe(sha256(up));

    socket.end();
    const got = await received;
    expect(got.length).toBe(size);
    expect(sha256(got)).toBe(sha256(down));
  }, 60_000);

  it('end(data, cb): the client gets the data, then EOF; cb fires', async () => {
    const { name, next } = listen();
    const client = await connect(name);
    const socket = await next();
    const received = readAll(client);
    const data = pattern(4096, 3);
    const cb = vi.fn();
    socket.end(data, cb);
    const got = await received;
    expect(sha256(got)).toBe(sha256(data));
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // end() closed the pipe: the socket closes once its readable side ends.
    socket.resume();
    await closed(socket);
  });

  // end() closes the handle without a disconnect: a client that is behind
  // must still read every byte the pipe took before it sees the end.
  it.each([
    { label: 'a few KB', first: 0, last: 4 * 1024 },
    { label: 'a few KB, then over 64 KB', first: 4 * 1024, last: 200 * 1024 },
  ])('end() loses no bytes to a slow client: $label', async ({ first, last }) => {
    const { name, next } = listen();
    const client = slowClient(name, 1024, 5);
    const socket = await next();
    const { line } = await firstLine(socket);
    expect(line).toBe('hello');
    const head = pattern(first, 4);
    const tail = pattern(last, 5);
    const expected = Buffer.concat([head, tail]);
    if (first > 0) socket.write(head);
    let cbAt = 0;
    let cbError: unknown;
    socket.end(tail, (err?: Error | null) => { cbAt = Date.now(); cbError = err; });
    const got = await client.result;
    const lost = expected.length - got.total;
    expect(lost, `lost ${lost} of ${expected.length} bytes (client ended with ${got.end})`).toBe(0);
    expect(got.sha256).toBe(sha256(expected));
    await vi.waitFor(() => expect(cbAt).toBeGreaterThan(0), { timeout: 10_000 });
    expect(cbError ?? null).toBeNull();
    // Whether the client was still reading when cb fired (the case that
    // could lose bytes), for the log.
    console.info(`[native-pipe] ${expected.length} bytes; client finished ${got.endAt - cbAt} ms after cb (${got.end})`);
    // The first-line read paused the socket; its readable side ends on resume.
    socket.resume();
    await closed(socket);
  }, 60_000);

  it('1,000 connections opened and closed: workers and handles back to baseline', async () => {
    const { name, next } = listen(pipeName(), 4);
    const workers = () => pipe?.nativePipeWorkerCount?.() ?? 0;
    const handles = () => pipe?.nativePipeHandleCount?.() ?? 0;
    // Warm up once, so lazily created process state is in the baseline.
    {
      const client = await connect(name);
      const socket = await next();
      client.destroy();
      socket.resume();
      await closed(socket);
    }
    const baseWorkers = workers();
    const baseHandles = handles();
    for (let i = 0; i < 1000; i++) {
      const client = await connect(name);
      const socket = await next();
      socket.on('error', noop);
      client.destroy();
      socket.resume();
      await closed(socket);
    }
    await vi.waitFor(() => expect(workers()).toBe(baseWorkers), { timeout: 10_000 });
    // The process's own handle count moves a little with node's own work.
    await vi.waitFor(() => expect(handles()).toBeLessThanOrEqual(baseHandles + 32), { timeout: 10_000 });
  }, 120_000);

  it('a new listener takes the name while a client of the closed one is still open', async () => {
    const first = listen();
    // A raw client handle that never reads, so nothing closes it when the
    // server end goes away (a net client would see EOF and close itself).
    const old = fs.openSync(first.name, 'r+');
    cleanups.push(() => fs.closeSync(old));
    const oldSocket = await first.next();
    first.server.close();
    oldSocket.destroy();
    await closed(oldSocket);
    // The native close finishes off the JS thread: the name is free once the
    // old server ends are closed (EADDRINUSE until then).
    const second = await vi.waitFor(() => listen(first.name), { timeout: 10_000, interval: 20 });
    const client = await connect(second.name);
    const socket = await second.next();
    const got = readAll(client);
    socket.end('again');
    expect((await got).toString()).toBe('again');
  });

  it('destroy while a read is outstanding joins the workers', async () => {
    const workers = () => pipe?.nativePipeWorkerCount?.() ?? 0;
    const { name, next } = listen();
    // Baseline with the listener's own worker running: after one connection.
    {
      const client = await connect(name);
      const warm = await next();
      client.destroy();
      warm.resume();
      await closed(warm);
    }
    const base = workers();
    await connect(name);
    const socket = await next();
    socket.on('data', noop);
    // The read is outstanding: the client sends nothing.
    await deliberateSleep(50, 'a read outstanding with no data: nothing completes to wait for');
    socket.destroy();
    await closed(socket);
    await vi.waitFor(() => expect(workers()).toBeLessThanOrEqual(base), { timeout: 10_000 });
  });
});

// pipe-listener-v2: the client's own token, read after its first bytes, and
// the owner of a pipe by name.
describe.runIf(pipe)('native pipe listener: token facts and pipe owners', () => {
  it('reads this user and at least Medium integrity from a client of this process', async () => {
    const { name, next } = listen();
    const client = await connect(name);
    const socket = await next();
    client.write('hello\n');
    await firstLine(socket);
    const facts = await socket.tokenFacts(5000);
    expect(facts).toMatchObject({ ok: true, sameUser: true });
    expect(facts.ok && facts.integrityRid).toBeGreaterThanOrEqual(0x2000);
    expect(socket.peer.pid).toBe(process.pid);
  });

  it('before any read the answer is no-read-yet, and a read after it works', async () => {
    const { name, next } = listen();
    const client = await connect(name);
    const socket = await next();
    expect(await socket.tokenFacts(5000)).toEqual({ ok: false, reason: 'no-read-yet' });
    client.write('later\n');
    const { line } = await firstLine(socket);
    expect(line).toBe('later');
    expect(await socket.tokenFacts(5000)).toMatchObject({ ok: true, sameUser: true });
  });

  it('a client that leaves while its token is read: the listener and this process carry on', async () => {
    const { name, next } = listen();
    for (let i = 0; i < 20; i++) {
      const client = await connect(name);
      const socket = await next();
      client.write('x\n');
      await firstLine(socket);
      const asked = socket.tokenFacts(5000);
      client.destroy();
      const facts = await asked;
      // Either read in time or not; never a hang, never another user.
      if (facts.ok) expect(facts.sameUser).toBe(true);
      socket.destroy();
    }
    // This process still runs as itself: a file it creates is its own to read.
    const file = path.join(os.tmpdir(), `wmux-native-pipe-facts-${process.pid}.txt`);
    fs.writeFileSync(file, 'still me');
    expect(fs.readFileSync(file, 'utf8')).toBe('still me');
    fs.rmSync(file, { force: true });
    const client = await connect(name);
    const socket = await next();
    client.write('after\n');
    await firstLine(socket);
    expect(await socket.tokenFacts(5000)).toMatchObject({ ok: true, sameUser: true });
  });

  it('owner verdicts: this listener is ours, a missing name is none', () => {
    const { name } = listen();
    expect(pipe!.nativePipeOwnedByUs(name)).toBe('ours');
    expect(pipe!.nativePipeOwnedByUs(`${name}-missing`)).toBe('none');
  });
});
