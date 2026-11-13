// A session pipe whose client stops reading (main's event loop stalled).
// Past SESSION_PIPE_RESYNC_BYTES queued the pipe stops writing live output,
// asks for a re-flush once the client has drained, asks again while none
// starts, and catches up when one runs. Real sockets, a real ring.

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SessionPipe, SESSION_PIPE_RESYNC_BYTES, createSessionPipeMarkers } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { generateSnapshot } from '../HeadlessSnapshot';
import { waitFor, deliberateSleep } from '../../test-utils/waitFor';

const TOKEN = 'slow-reader-token';
const { flushDone: FLUSH_DONE, resyncBegin: RESYNC_BEGIN } = createSessionPipeMarkers(TOKEN);
const CHUNK = 64 * 1024;

interface Client { socket: net.Socket; chunks: Buffer[]; wire: () => Buffer }

function connectClient(pipeName: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(pipeName, () => {
      socket.write(TOKEN + '\n');
      resolve({ socket, chunks, wire: () => Buffer.concat(chunks) });
    });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
  });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const line = (n: number): Buffer => Buffer.from(`line-${n} ${'x'.repeat(CHUNK - 20)}\r\n`.slice(0, CHUNK));

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) {
    try { await c(); } catch { /* best-effort */ }
  }
  cleanups = [];
});

async function attachedPipe(tag: string, ringBytes = 32 * 1024 * 1024) {
  const ring = new RingBuffer(ringBytes, 'node');
  const pipe = new SessionPipe(`slow-${tag}-${crypto.randomUUID().slice(0, 8)}`, ring, TOKEN);
  cleanups.push(() => pipe.stop());
  await pipe.start();
  return { ring, pipe };
}

describe('SessionPipe with a client that stops reading', () => {
  it('stops queueing at the bound, asks for a re-flush on drain, asks again, and catches up', async () => {
    const { ring, pipe } = await attachedPipe('behind');
    const asked: number[] = [];
    pipe.onResyncNeeded = (ask) => asked.push(ask);
    pipe.resyncRetryMs = 100;
    const client = await connectClient(pipe.getPipeName());
    cleanups.push(() => client.socket.destroy());
    await waitFor(() => pipe.isFlushed, 3000);
    client.socket.pause();

    const pane = (data: Buffer): void => {
      ring.write(data);
      pipe.writeToClient(data);
    };
    let n = 0;
    while (!pipe.isBehind && n < 2000) {
      pane(line(n++));
      await tick();
    }
    expect(pipe.isBehind).toBe(true);
    const queuedAtBound = pipe.getMemoryDiagnostics().socketQueuedBytes;
    expect(queuedAtBound).toBeGreaterThan(SESSION_PIPE_RESYNC_BYTES);
    expect(queuedAtBound).toBeLessThanOrEqual(SESSION_PIPE_RESYNC_BYTES + CHUNK);

    // The pane keeps printing: none of it is queued, all of it is in the ring.
    for (let i = 0; i < 32; i++) pane(line(n++));
    const last = n - 1;
    expect(pipe.getMemoryDiagnostics().socketQueuedBytes).toBeLessThanOrEqual(queuedAtBound);
    expect(asked).toHaveLength(0);

    // The client reads again: once it has drained, the pipe asks.
    client.socket.resume();
    await waitFor(() => asked.length >= 1, 10_000);
    // Nobody answered (a lost request): the pipe asks again.
    await waitFor(() => asked.length >= 2, 3000);
    // Counted from the first ask since the pipe fell behind (the daemon's log cadence).
    expect(asked.slice(0, 2)).toEqual([1, 2]);

    const bridge = new EventEmitter();
    const result = await pipe.reflush({ bridge, cols: 80, rows: 24, generate: generateSnapshot });
    expect(result.mode === 'snapshot' || result.mode === 'raw').toBe(true);
    expect(pipe.isBehind).toBe(false);
    const askedByReflush = asked.length;
    await deliberateSleep(300, 'negative check: three retry intervals pass with no new request');
    expect(asked).toHaveLength(askedByReflush);

    // Live output flows again, after the re-flush.
    pane(Buffer.from('after-the-reflush\r\n'));
    await waitFor(() => client.wire().includes('after-the-reflush'), 5000);
    const wire = client.wire();
    const begin = wire.lastIndexOf(RESYNC_BEGIN);
    const done = wire.indexOf(FLUSH_DONE, begin);
    expect(begin).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(begin);
    // The re-flush carries what the client did not get live: the last line printed while behind.
    expect(wire.subarray(begin, done).includes(`line-${last} `)).toBe(true);
    expect(wire.indexOf('after-the-reflush', done)).toBeGreaterThan(done);
    // And nothing printed while behind went out live, before the re-flush.
    expect(wire.subarray(0, begin).includes(`line-${last} `)).toBe(false);
  }, 60_000);

  it('a replay larger than the bound does not put the pipe straight back behind', async () => {
    const { ring, pipe } = await attachedPipe('bigreplay');
    // More history than the bound; no dims, so the attach ships it raw.
    for (let i = 0; i < (SESSION_PIPE_RESYNC_BYTES / CHUNK) + 32; i++) ring.write(line(i));
    const client = await connectClient(pipe.getPipeName());
    cleanups.push(() => client.socket.destroy());
    client.socket.pause();
    await waitFor(() => pipe.isFlushed, 10_000);
    expect(pipe.getMemoryDiagnostics().socketQueuedBytes).toBeGreaterThan(SESSION_PIPE_RESYNC_BYTES);

    pipe.writeToClient(Buffer.from('live after a big replay\r\n'));
    expect(pipe.isBehind).toBe(false);
    client.socket.resume();
    await waitFor(() => client.wire().includes('live after a big replay'), 10_000);
  }, 60_000);

  // Fills a paused client's queue until the pipe falls behind.
  async function fallBehind(ring: RingBuffer, pipe: SessionPipe): Promise<number> {
    let n = 0;
    while (!pipe.isBehind && n < 2000) {
      const data = line(n++);
      ring.write(data);
      pipe.writeToClient(data);
      await tick();
    }
    expect(pipe.isBehind).toBe(true);
    return n;
  }

  it('output the pane prints while the re-flush is generated goes out once, after its replay', async () => {
    const { ring, pipe } = await attachedPipe('tee');
    const client = await connectClient(pipe.getPipeName());
    cleanups.push(() => client.socket.destroy());
    await waitFor(() => pipe.isFlushed, 3000);
    client.socket.pause();
    await fallBehind(ring, pipe);
    client.socket.resume();

    // The pane as the session manager drives it: ring, bridge 'data', pipe.
    const bridge = new EventEmitter();
    const print = (text: string): void => {
      const data = Buffer.from(text);
      ring.write(data);
      bridge.emit('data', data);
      pipe.writeToClient(data);
    };
    const result = await pipe.reflush({
      bridge, cols: 80, rows: 24,
      generate: async (req) => {
        // Between T0 and T1: printed while the snapshot is being made.
        print('during-generation-1\r\n');
        await tick();
        print('during-generation-2\r\n');
        return generateSnapshot(req);
      },
    });
    expect(result.mode).toBe('snapshot');
    print('after-the-reflush\r\n');
    await waitFor(() => client.wire().includes('after-the-reflush'), 10_000);
    const wire = client.wire();
    const begin = wire.lastIndexOf(RESYNC_BEGIN);
    const count = (needle: string): number => wire.subarray(begin).toString('latin1').split(needle).length - 1;
    expect(count('during-generation-1')).toBe(1);
    expect(count('during-generation-2')).toBe(1);
    expect(wire.subarray(0, begin).includes('during-generation')).toBe(false);
    expect(wire.indexOf('during-generation-2', begin)).toBeLessThan(wire.indexOf('after-the-reflush', begin));
  }, 60_000);

  it('a stopped pipe asks for nothing more', async () => {
    const { ring, pipe } = await attachedPipe('stop');
    const asked: number[] = [];
    pipe.onResyncNeeded = (ask) => asked.push(ask);
    pipe.resyncRetryMs = 50;
    const client = await connectClient(pipe.getPipeName());
    cleanups.push(() => client.socket.destroy());
    await waitFor(() => pipe.isFlushed, 3000);
    client.socket.pause();
    await fallBehind(ring, pipe);
    client.socket.resume();
    await waitFor(() => asked.length >= 1, 10_000);
    pipe.stop();
    const asks = asked.length;
    await deliberateSleep(300, 'negative check: six retry intervals pass after stop');
    expect(asked).toHaveLength(asks);
  }, 60_000);

  it('a new client starts caught up', async () => {
    const { ring, pipe } = await attachedPipe('newclient');
    const first = await connectClient(pipe.getPipeName());
    await waitFor(() => pipe.isFlushed, 3000);
    first.socket.pause();
    let n = 0;
    while (!pipe.isBehind && n < 2000) {
      const data = line(n++);
      ring.write(data);
      pipe.writeToClient(data);
      await tick();
    }
    expect(pipe.isBehind).toBe(true);
    first.socket.destroy();
    await waitFor(() => !pipe.hasClient(), 3000);
    expect(pipe.isBehind).toBe(false);

    const second = await connectClient(pipe.getPipeName());
    cleanups.push(() => second.socket.destroy());
    await waitFor(() => pipe.isFlushed, 10_000);
    pipe.writeToClient(Buffer.from('second-client-live\r\n'));
    await waitFor(() => second.wire().includes('second-client-live'), 10_000);
  }, 60_000);
});
