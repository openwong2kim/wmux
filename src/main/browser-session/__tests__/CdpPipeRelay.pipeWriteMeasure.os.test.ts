// Measurement only: how the relay's drain sign (writeProgress) moves when one
// large message leaves as 64 KiB WebSocket fragments, on this OS's local
// socket (a named pipe on Windows, a unix socket elsewhere). A ws server sends
// to a ws client whose bytes are handed over CHUNK by CHUNK from the pipe.
// Four legs: all fragments at once (unpaced), one fragment in flight at a
// time (paced), a reader that stops (stopped), and a ping between two paced
// fragments (pong). Each leg prints one `[pipeWriteMeasure <platform>]` line,
// also appended to $GITHUB_STEP_SUMMARY. The assertions only check that the
// measurement itself holds (every byte arrived in order, the stopped leg
// really stopped); the numbers are recorded, not judged.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { writeProgress } from '../CdpPipeRelay';

const FRAME = 1 << 20;
const FRAG = 64 << 10;
const CHUNK = 16 << 10;
const STOP_AT = 128 << 10;
/** A 64 KiB fragment's header: 2 bytes plus an 8-byte length, unmasked. */
const HEADER = 10;
const PARTS = FRAME / FRAG;
/** The whole message on the wire. */
const WIRE = PARTS * (FRAG + HEADER);
const TAG = `[pipeWriteMeasure ${process.platform}]`;

/** Position-dependent bytes (251 is prime, so a swapped fragment shows). */
const SOURCE = Buffer.from(Array.from({ length: FRAME }, (_, i) => i % 251));
const fragments = (): Buffer[] => Array.from({ length: PARTS }, (_, i) => SOURCE.subarray(i * FRAG, (i + 1) * FRAG));

let record: { leg: string; status: string; fields: Record<string, string | number> } | null = null;
const cleanups: Array<() => void> = [];
afterEach(() => {
  // The line goes out first, so a leg that hangs or fails still reports.
  if (record) {
    const line = `${TAG} leg=${record.leg} status=${record.status} ${Object.entries(record.fields).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    console.log(line);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      try { fs.appendFileSync(summary, `\`${line}\`\n\n`); } catch { /* best effort */ }
    }
    record = null;
  }
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
});

async function listen(server: Server): Promise<net.NetConnectOpts> {
  let where: string;
  if (process.platform === 'win32') {
    where = `\\\\.\\pipe\\wmux-pipe-write-measure-${randomBytes(6).toString('hex')}`;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pwm-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    where = path.join(dir, 's');
  }
  await new Promise<void>((resolve) => server.listen(where, resolve));
  return { path: where };
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

interface Link {
  /** The server side, whose sends are measured. */
  server: WebSocket;
  /** The server's socket, read by writeProgress. */
  socket: Duplex;
  /** The client end of the pipe; the test reads it by hand. */
  pipe: net.Socket;
  /** The ws client; it sees only the bytes the test hands it. */
  client: WebSocket;
  feed: Duplex;
  /** Bytes handed to the client since the handshake. */
  consumed: number;
  /** writeProgress().flushed and pipe.bytesRead right after the handshake. */
  flushedBase: number;
  readBase: number;
  clientErrors: string[];
}

async function connect(): Promise<Link> {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  const accepted = new Promise<{ server: WebSocket; socket: Duplex }>((resolve) => {
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (server) => resolve({ server, socket })));
  });
  cleanups.push(() => { wss.close(); http.close(); });
  const target = await listen(http);

  const pipe = net.connect(target);
  cleanups.push(() => pipe.destroy());
  await new Promise<void>((resolve, reject) => { pipe.once('connect', resolve); pipe.once('error', reject); });

  // The client writes straight to the pipe, and reads only what is pushed here.
  const feed = new Duplex({
    read() { /* the test pushes */ },
    write(chunk: Buffer, _enc, cb) { pipe.write(chunk, cb); },
    final(cb) { pipe.end(); cb(); },
  });
  const clientErrors: string[] = [];
  const client = new WebSocket('ws://localhost/', {
    createConnection: () => feed as unknown as net.Socket,
    perMessageDeflate: false,
  });
  client.on('error', (err) => clientErrors.push(err.message));
  cleanups.push(() => client.terminate());
  const opened = new Promise<void>((resolve) => client.once('open', () => resolve()));
  let open = false;
  void opened.then(() => { open = true; });

  // The handshake answer, handed over whole.
  while (!open) {
    await Promise.race([readable(pipe), opened]);
    const got = pipe.read() as Buffer | null;
    if (got) feed.push(got);
  }
  const { server, socket } = await accepted;
  // The stopped leg leaves a send pending at teardown; its error is expected.
  server.on('error', () => { /* teardown */ });
  cleanups.push(() => server.terminate());
  return {
    server, socket, pipe, client, feed, consumed: 0,
    flushedBase: writeProgress(server, socket).flushed,
    readBase: pipe.bytesRead,
    clientErrors,
  };
}

const flushed = (link: Link): number => writeProgress(link.server, link.socket).flushed - link.flushedBase;

/** Hands the client at most `max` bytes, once the pipe has any. */
async function step(link: Link, max: number): Promise<void> {
  await readable(link.pipe);
  const got = link.pipe.read(Math.min(max, link.pipe.readableLength)) as Buffer | null;
  if (got) { link.consumed += got.length; link.feed.push(got); }
}

interface Pacer { sent: number; completed: number; completedBytes: number; inFlight: boolean }

/** One fragment in flight: the next is sent from the previous one's write callback. */
function sendPaced(ws: WebSocket, parts: Buffer[], before?: (next: number) => void): Pacer {
  const pacer: Pacer = { sent: 0, completed: 0, completedBytes: 0, inFlight: false };
  const next = () => {
    const i = pacer.sent++;
    pacer.inFlight = true;
    ws.send(parts[i], { binary: true, fin: i === parts.length - 1, compress: false }, (err) => {
      pacer.inFlight = false;
      if (err) return; // only at teardown
      pacer.completed++;
      pacer.completedBytes += parts[i].length + HEADER;
      if (pacer.sent < parts.length) { before?.(pacer.sent); next(); }
    });
  };
  next();
  return pacer;
}

/** Every fragment handed to ws at once. */
function sendUnpaced(ws: WebSocket, parts: Buffer[]): Pacer {
  const pacer: Pacer = { sent: 0, completed: 0, completedBytes: 0, inFlight: true };
  parts.forEach((part, i) => {
    pacer.sent++;
    ws.send(part, { binary: true, fin: i === parts.length - 1, compress: false }, (err) => {
      if (err) return;
      pacer.completed++;
      pacer.completedBytes += part.length + HEADER;
      pacer.inFlight = pacer.completed < parts.length;
    });
  });
  return pacer;
}

/** `value×count` runs, in KiB, comma-separated. */
function runs(values: number[]): string {
  const out: Array<[number, number]> = [];
  for (const v of values) {
    const kib = Math.round(v / 1024);
    const last = out.at(-1);
    if (last && last[0] === kib) last[1]++;
    else out.push([kib, 1]);
  }
  return out.map(([kib, n]) => `${kib}×${n}`).join(',');
}

/** The client reads the whole message CHUNK by CHUNK; flushed is sampled before each read. */
async function readAll(link: Link, pacer: Pacer, wire: number) {
  const message = new Promise<Buffer>((resolve) => link.client.once('message', (data) => resolve(data as Buffer)));
  const samples: Array<{ flushed: number; mid: boolean }> = [];
  while (link.consumed < wire) {
    samples.push({ flushed: flushed(link), mid: pacer.completed < PARTS });
    await step(link, CHUNK);
  }
  samples.push({ flushed: flushed(link), mid: pacer.completed < PARTS });
  const data = await message;
  const mid = samples.filter((s) => s.mid);
  const rises = mid.filter((s, i) => i > 0 && s.flushed > mid[i - 1].flushed).length;
  return { data, samples, mid, rises };
}

describe('write progress with a fragmented message on a real pipe (measured only)', () => {
  it('unpaced: every fragment sent at once', async () => {
    record = { leg: 'unpaced', status: 'running', fields: {} };
    const link = await connect();
    const pacer = sendUnpaced(link.server, fragments());
    const { data, samples, mid, rises } = await readAll(link, pacer, WIRE);
    Object.assign(record.fields, {
      rises, midSamples: mid.length, flushedSamples: runs(samples.map((s) => s.flushed)),
      completedBytes: pacer.completedBytes, expectedRisesAtLeast: PARTS - 2,
    });
    record.status = 'done';
    expect(link.clientErrors).toEqual([]);
    expect(data.equals(SOURCE)).toBe(true);
  });

  it('paced: one fragment in flight', async () => {
    record = { leg: 'paced', status: 'running', fields: {} };
    const link = await connect();
    const pacer = sendPaced(link.server, fragments());
    const { data, samples, mid, rises } = await readAll(link, pacer, WIRE);
    Object.assign(record.fields, {
      rises, midSamples: mid.length, flushedSamples: runs(samples.map((s) => s.flushed)),
      completedBytes: pacer.completedBytes, expectedRisesAtLeast: PARTS - 2,
    });
    record.status = 'done';
    expect(link.clientErrors).toEqual([]);
    expect(data.equals(SOURCE)).toBe(true);
  });

  it('stopped: the reader stops after 128 KiB while paced sending goes on', async () => {
    record = { leg: 'stopped', status: 'running', fields: {} };
    const fields = record.fields;
    const link = await connect();
    const pacer = sendPaced(link.server, fragments());
    while (link.consumed < STOP_AT) await step(link, Math.min(CHUNK, STOP_AT - link.consumed));

    // Stopped means: a send still waits on its write callback, and two round
    // trips the other way through the pipe in a row change nothing.
    const probed = () => new Promise<void>((resolve) => {
      link.server.once('message', () => resolve());
      link.client.send('probe');
    });
    const snapshot = () => `${pacer.completed}/${link.pipe.bytesRead}/${flushed(link)}`;
    let prev = snapshot();
    let still = 0;
    let probes = 0;
    while (still < 2 && pacer.completed < PARTS) {
      await probed();
      probes++;
      const now = snapshot();
      still = now === prev && pacer.inFlight ? still + 1 : 0;
      prev = now;
      Object.assign(fields, { probes, fragmentsCompleted: pacer.completed });
    }
    const handle = (link.socket as unknown as { _handle?: { writeQueueSize?: number } })._handle;
    Object.assign(fields, {
      consumed: link.consumed,
      pulled: link.pipe.bytesRead - link.readBase,
      completedBytes: pacer.completedBytes,
      fragmentsCompleted: pacer.completed,
      flushedBytes: flushed(link),
      pendingBytes: handle?.writeQueueSize ?? -1,
      probes,
      expectedCompletedAtMost: STOP_AT + FRAG + FRAG + HEADER,
    });
    record.status = 'done';
    expect(link.clientErrors).toEqual([]);
    expect(pacer.completed).toBeLessThan(PARTS);
    expect(pacer.inFlight).toBe(true);
    expect(still).toBe(2);
  });

  it('pong: a ping sent between two paced fragments', async () => {
    record = { leg: 'pong', status: 'running', fields: {} };
    const link = await connect();
    const half = PARTS / 2;
    // The ping frame is 2 bytes (no payload), right after fragment half-1.
    const wire = WIRE + 2;
    const pingAt = half * (FRAG + HEADER);
    let pong: { consumed: number; completed: number } | null = null;
    const ponged = new Promise<void>((resolve) => link.server.once('pong', () => {
      pong = { consumed: link.consumed, completed: pacer.completed };
      resolve();
    }));
    const pacer = sendPaced(link.server, fragments(), (next) => { if (next === half) link.server.ping(); });
    const { data, rises } = await readAll(link, pacer, wire);
    await ponged;
    const at = pong as { consumed: number; completed: number } | null;
    Object.assign(record.fields, {
      pingAtOffset: pingAt,
      pongAtOffset: at?.consumed ?? -1,
      pongBeforeFinal: at ? at.consumed < wire : 'unknown',
      fragmentsCompletedAtPong: at?.completed ?? -1,
      wireBytes: wire,
      rises,
    });
    record.status = 'done';
    expect(link.clientErrors).toEqual([]);
    expect(data.equals(SOURCE)).toBe(true);
  });
});
