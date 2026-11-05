// A pane's reattach replaces its session pipe (daemon.attachSession stops the
// old one). Input main wrote to the old pipe just before must still reach the
// PTY (#3073): destroying the socket discarded the bytes the daemon had not
// read yet, while main had reported them written.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { RingBuffer } from '../RingBuffer';
import { SessionPipe, createSessionPipeMarkers } from '../SessionPipe';
import { waitFor } from '../../test-utils/waitFor';

const TOKEN = 'release-test-token';
const FLUSH_DONE = createSessionPipeMarkers(TOKEN).flushDone;

const sockets: net.Socket[] = [];
const pipes: SessionPipe[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const p of pipes.splice(0)) await p.stop().catch(() => undefined);
});

/** A started pipe, a flushed client on it, and what the PTY was given. */
async function connected(clientOpts: { allowHalfOpen?: boolean } = {}): Promise<{ pipe: SessionPipe; socket: net.Socket; input: () => string }> {
  const ring = new RingBuffer(64 * 1024);
  ring.write(Buffer.from('$ '));
  const pipe = new SessionPipe(`release-${crypto.randomUUID().slice(0, 8)}`, ring, TOKEN);
  pipes.push(pipe);
  const received: Buffer[] = [];
  pipe.onInput((data) => { received.push(data); });
  await pipe.start();
  const chunks: Buffer[] = [];
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ ...clientOpts, path: pipe.getPipeName() }, () => { s.write(TOKEN + '\n'); resolve(s); });
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('error', reject);
    sockets.push(s);
  });
  await waitFor(() => Buffer.concat(chunks).includes(FLUSH_DONE), 10_000);
  return { pipe, socket, input: () => Buffer.concat(received).toString('utf8') };
}

describe('SessionPipe.releaseClient', () => {
  it('input the client sent right before the pipe is replaced reaches the PTY', async () => {
    const { pipe, socket, input } = await connected();
    const text = `echo marker-${'x'.repeat(64 * 1024)}`;
    socket.write(text);
    // The attach's replacement, in the same tick: nothing has been read yet.
    await pipe.releaseClient();
    await pipe.stop();
    expect(input()).toBe(text);
    expect(socket.writable).toBe(false);
  });

  it('a client that keeps its side open is let go at the bound, and stop() ends it', async () => {
    const { pipe, socket } = await connected({ allowHalfOpen: true });
    const startedAt = Date.now();
    await pipe.releaseClient(150);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    await pipe.stop();
    await waitFor(() => socket.destroyed || socket.readableEnded, 5_000);
  });

  it('is a no-op with no client', async () => {
    const ring = new RingBuffer(1024);
    const pipe = new SessionPipe(`release-${crypto.randomUUID().slice(0, 8)}`, ring, TOKEN);
    pipes.push(pipe);
    await pipe.start();
    await expect(pipe.releaseClient()).resolves.toBeUndefined();
  });
});
