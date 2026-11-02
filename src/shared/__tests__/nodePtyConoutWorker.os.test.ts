// #2398 — node-pty's shared conout drain worker itself
// (lib/worker/conoutSocketWorker.js, patches/node-pty+1.2.0-beta.17.patch),
// run as a real Worker against fake conout named pipes. The parent's side of
// the protocol, with the Worker swapped for a fake: nodePtyConoutDrain.test.ts;
// real ptys: nodePtyConoutDrain.os.test.ts.
//
// A fake conout pipe is a local pipe server standing in for ConPTY: the drain
// connects to it as ConPTY's output reader, and the test connects to the
// drain's `<pipe>-worker` server as the pty's output socket. Windows only: the
// drain worker is the ConPTY path, and the pipe names are Windows pipe names.

import { createRequire } from 'node:module';
import net from 'node:net';
import { Worker } from 'node:worker_threads';
import { StringDecoder } from 'node:string_decoder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliberateSleep } from '../../test-utils/waitFor';

const WORKER_SCRIPT = createRequire(__filename).resolve('node-pty/lib/worker/conoutSocketWorker.js');
const READY = 1;
const ERROR = 2;
const CLOSED = 3;

interface Reply { type: number; id: number; error?: string }

let pipeCount = 0;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface FakeConout { name: string; peer: Promise<net.Socket> }

/** A pipe server in ConPTY's place; `peer` is its end of the drain's connection. */
async function fakeConout(): Promise<FakeConout> {
  const name = `\\\\.\\pipe\\wmux-conout-worker-test-${process.pid}-${++pipeCount}`;
  let accepted!: (socket: net.Socket) => void;
  const peer = new Promise<net.Socket>((resolve) => { accepted = resolve; });
  const server = net.createServer((socket) => {
    // A drain closed under it breaks ConPTY's end of the pipe: expected here.
    socket.on('error', () => undefined);
    cleanups.push(() => socket.destroy());
    accepted(socket);
  });
  await new Promise<void>((resolve) => server.listen(name, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { name, peer };
}

interface DrainWorker {
  worker: Worker;
  replies: Reply[];
  exited: boolean;
  open: (id: number, conoutPipeName?: string | object) => void;
  reply: (id: number) => Promise<Reply>;
}

function startWorker(): DrainWorker {
  const worker = new Worker(WORKER_SCRIPT);
  const drain: DrainWorker = {
    worker,
    replies: [],
    exited: false,
    open: (id, conoutPipeName) => worker.postMessage({ type: 'open', id, conoutPipeName }),
    reply: (id) => new Promise((resolve, reject) => {
      const found = drain.replies.find((reply) => reply.id === id);
      if (found) return resolve(found);
      const listener = (reply: Reply): void => {
        if (reply.id !== id) return;
        worker.off('message', listener);
        resolve(reply);
      };
      worker.on('message', listener);
      worker.once('exit', (code) => reject(new Error(`drain worker exited (code ${code}) before replying for ${id}`)));
    }),
  };
  worker.on('message', (reply: Reply) => drain.replies.push(reply));
  // Asserted through `exited` and the replies, not the error itself.
  worker.on('error', () => undefined);
  worker.on('exit', () => { drain.exited = true; });
  cleanups.push(() => worker.terminate());
  return drain;
}

/** The pty's output socket: a client of the drain's `-worker` server. */
async function connectOutput(conout: FakeConout): Promise<net.Socket> {
  const socket = net.connect(`${conout.name}-worker`);
  cleanups.push(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** Whether anything still listens on the drain's `-worker` pipe. */
function isListening(conout: FakeConout): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(`${conout.name}-worker`);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

/** Resolves when every byte written so far has left the writer. */
function flushed(socket: net.Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve) => socket.write(data, () => resolve()));
}

function collect(socket: net.Socket): { bytes: () => Buffer; chunks: () => Buffer[]; ended: Promise<void> } {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve) => socket.once('end', resolve));
  return { bytes: () => Buffer.concat(chunks), chunks: () => chunks, ended };
}

/** Distinct bytes per pty, so a misrouted or reordered chunk shows. */
function payload(tag: string, size: number): Buffer {
  const line = (n: number): string => `${tag}${String(n).padStart(8, '0')}\n`;
  const parts: string[] = [];
  let length = 0;
  for (let n = 0; length < size; n++) {
    parts.push(line(n));
    length += line(n).length;
  }
  return Buffer.from(parts.join(''));
}

describe.runIf(process.platform === 'win32')('node-pty conout drain worker (patched)', () => {
  it('drains each pty\'s conout pipe to its own output socket', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    drain.open(2, b.name);
    expect(await drain.reply(1)).toEqual({ type: READY, id: 1 });
    expect(await drain.reply(2)).toEqual({ type: READY, id: 2 });
    const outA = collect(await connectOutput(a));
    const outB = collect(await connectOutput(b));
    await flushed(await a.peer, 'to a');
    await flushed(await b.peer, 'to b');
    await vi.waitFor(() => {
      expect(outA.bytes().toString()).toBe('to a');
      expect(outB.bytes().toString()).toBe('to b');
    }, { timeout: 10_000 });
  });

  it('closes a drain the parent closes before it is ready, and never reports it ready', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    drain.worker.postMessage({ type: 'close', id: 1 });
    drain.open(2, b.name);
    // The worker handles its messages in order, so by B's READY it has
    // closed A: A's connect callback, and its listen, never run.
    expect(await drain.reply(2)).toEqual({ type: READY, id: 2 });
    await deliberateSleep(100, 'negative: no reply ever comes for the closed drain');
    expect(drain.replies.filter((reply) => reply.id === 1)).toEqual([]);
    expect(await isListening(a)).toBe(false);
    expect(await isListening(b)).toBe(true);
  });

  it('fails only the drain whose open message cannot be handled, and keeps draining the others', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    drain.open(1, a.name);
    await drain.reply(1);
    const outA = collect(await connectOutput(a));

    // No pipe name: net.Socket#connect throws inside the worker's handler.
    drain.open(2);
    expect(await drain.reply(2)).toEqual({ type: ERROR, id: 2, error: expect.any(String) });

    await flushed(await a.peer, 'still here');
    await vi.waitFor(() => expect(outA.bytes().toString()).toBe('still here'), { timeout: 10_000 });
    expect(drain.exited).toBe(false);
    expect(drain.replies.filter((reply) => reply.id === 1)).toEqual([{ type: READY, id: 1 }]);
  });

  it('fails only the drain whose pipe connect callback throws, and keeps draining the others', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    await drain.reply(1);
    const outA = collect(await connectOutput(a));

    // That callback runs outside the message handler. listen() reports every
    // pipe name failure through 'error', never by throwing, so the one throw
    // reachable there is naming the worker pipe: connect() takes these
    // options, but they cannot become a string ("".concat throws).
    drain.open(2, { path: b.name, toString: 0 });
    expect(await drain.reply(2)).toEqual({ type: ERROR, id: 2, error: expect.any(String) });
    expect(await isListening(b)).toBe(false);

    await flushed(await a.peer, 'still here');
    await vi.waitFor(() => expect(outA.bytes().toString()).toBe('still here'), { timeout: 10_000 });
    expect(drain.exited).toBe(false);
  });

  it('holds back only the pty whose reader is paused', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    drain.open(2, b.name);
    await Promise.all([drain.reply(1), drain.reply(2)]);
    const socketA = await connectOutput(a);
    socketA.pause();
    const outA = collect(socketA);
    const outB = collect(await connectOutput(b));
    const peerA = await a.peer;
    const peerB = await b.peer;

    // 8 MB into A: far more than the pipes and the drain hold in flight.
    const dataA = payload('a', 8 * 1024 * 1024);
    const dataB = payload('b', 2 * 1024 * 1024);
    let doneA = false;
    void flushed(peerA, dataA).then(() => { doneA = true; });
    await flushed(peerB, dataB);
    await vi.waitFor(() => expect(outB.bytes().length).toBe(dataB.length), { timeout: 10_000 });
    expect(outB.bytes().equals(dataB)).toBe(true);
    // A's writer is blocked: backpressure reached ConPTY's side of A's pipe.
    expect(doneA).toBe(false);
    expect(peerA.writableLength).toBeGreaterThan(0);

    socketA.resume();
    peerA.end();
    await outA.ended;
    expect(outA.bytes().equals(dataA)).toBe(true);
  });

  it('keeps reading a pty\'s conout pipe after its output socket is gone', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    drain.open(2, b.name);
    await Promise.all([drain.reply(1), drain.reply(2)]);
    const socketA = await connectOutput(a);
    const outB = collect(await connectOutput(b));
    const peerA = await a.peer;

    // The parent destroys A's output socket while A still has output: without
    // a reader the pipe fills and ConPTY blocks writing it (node-pty#375).
    socketA.destroy();
    peerA.write(payload('a', 4 * 1024 * 1024));
    await vi.waitFor(() => expect(peerA.writableLength).toBe(0), { timeout: 10_000 });

    await flushed(await b.peer, 'b lives');
    await vi.waitFor(() => expect(outB.bytes().toString()).toBe('b lives'), { timeout: 10_000 });
  });

  it('lets a pty\'s output socket take all of its conout pipe before it reports the drain closed', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    drain.open(1, a.name);
    await drain.reply(1);
    const socketA = await connectOutput(a);
    socketA.pause();
    const outA = collect(socketA);
    const closedA = new Promise<void>((resolve) => socketA.once('close', resolve));
    const peerA = await a.peer;

    // The shell exits by itself: ConPTY writes its last output and ends the pipe.
    const dataA = payload('a', 1024 * 1024);
    peerA.end(dataA);
    await deliberateSleep(300, 'negative: the drain is not reported closed while its reader is paused');
    // The reader has not taken it yet: the drain still holds what is left.
    expect(drain.replies.filter((reply) => reply.id === 1)).toEqual([{ type: READY, id: 1 }]);

    socketA.resume();
    await outA.ended;
    await closedA;
    expect(outA.bytes().equals(dataA)).toBe(true);
    // Then the drain is gone, and the worker tells the parent so.
    await vi.waitFor(() => expect(drain.replies).toContainEqual({ type: CLOSED, id: 1 }), { timeout: 10_000 });
    expect(await isListening(a)).toBe(false);
  });

  it('reports a drain closed when its pipe ends after its output socket is gone', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    drain.open(1, a.name);
    await drain.reply(1);
    const socketA = await connectOutput(a);
    const peerA = await a.peer;
    socketA.destroy();
    peerA.end('last words');
    await vi.waitFor(() => expect(drain.replies).toContainEqual({ type: CLOSED, id: 1 }), { timeout: 10_000 });
    expect(await isListening(a)).toBe(false);
  });

  it('forwards conout bytes unchanged, and a multi-byte character split across reads still decodes', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    drain.open(2, b.name);
    await Promise.all([drain.reply(1), drain.reply(2)]);
    const raw = collect(await connectOutput(a));
    const split = collect(await connectOutput(b));

    const bytes = Buffer.from([0x41, 0xff, 0x42, 0xed, 0x95]);
    await flushed(await a.peer, bytes);
    await vi.waitFor(() => expect(raw.bytes()).toEqual(bytes), { timeout: 10_000 });

    // The first byte of a three-byte character arrives on its own, the rest
    // later. windowsPtyAgent decodes its output socket as UTF-8, which is a
    // StringDecoder over the chunks as they come.
    const peerB = await b.peer;
    const han = Buffer.from('한', 'utf8');
    await flushed(peerB, han.subarray(0, 1));
    await vi.waitFor(() => expect(split.bytes().length).toBe(1), { timeout: 10_000 });
    await flushed(peerB, Buffer.concat([han.subarray(1), Buffer.from('z')]));
    await vi.waitFor(() => expect(split.bytes().length).toBe(4), { timeout: 10_000 });
    const decoder = new StringDecoder('utf8');
    expect(split.chunks().length).toBeGreaterThan(1);
    expect(split.chunks().map((chunk) => decoder.write(chunk)).join('') + decoder.end()).toBe('한z');
  });

  it('closes every pty\'s output socket when the worker ends', async () => {
    const drain = startWorker();
    const a = await fakeConout();
    const b = await fakeConout();
    drain.open(1, a.name);
    drain.open(2, b.name);
    await Promise.all([drain.reply(1), drain.reply(2)]);
    const sockets = [await connectOutput(a), await connectOutput(b)];
    const closed = sockets.map((socket) => new Promise<void>((resolve) => socket.once('close', resolve)));
    await drain.worker.terminate();
    await Promise.all(closed);
  });
});
