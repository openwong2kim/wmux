// The geometry history's provisional sizes (RingBuffer.noteGeometry): a pipe
// is awaiting its viewer's replay from the attach until the flush finishes,
// and the flush's end keeps the size the viewer then holds.
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { REPLAY_CONNECT_GRACE_MS, SessionPipe } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { waitFor } from '../../test-utils/waitFor';

const TOKEN = 'geometry-settle-token';

function connectAuthed(pipeName: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(pipeName, () => {
      socket.write(TOKEN + '\n');
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) {
    try { await c(); } catch { /* best-effort */ }
  }
  cleanups = [];
});

async function pipeWith(ring: RingBuffer): Promise<SessionPipe> {
  const pipe = new SessionPipe(`geomsettle-${crypto.randomUUID().slice(0, 8)}`, ring, TOKEN);
  cleanups.push(() => pipe.stop());
  await pipe.start();
  return pipe;
}

describe('SessionPipe and the geometry history', () => {
  it('awaits the replay from the attach until the flush ends, and again for the next client', async () => {
    const pipe = await pipeWith(new RingBuffer(64 * 1024));
    expect(pipe.awaitingReplay).toBe(true);

    const first = await connectAuthed(pipe.getPipeName());
    cleanups.push(() => { first.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);
    expect(pipe.awaitingReplay).toBe(false);

    // The client goes away: nobody waits for a replay.
    first.destroy();
    await waitFor(() => !pipe.hasClient(), 3000);
    expect(pipe.awaitingReplay).toBe(false);

    const second = await connectAuthed(pipe.getPipeName());
    cleanups.push(() => { second.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);
    expect(pipe.awaitingReplay).toBe(false);
  });

  it('stops awaiting a replay when no client connects within the grace', async () => {
    const pipe = await pipeWith(new RingBuffer(64 * 1024));
    expect(pipe.awaitingReplay).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + REPLAY_CONNECT_GRACE_MS + 1);
      expect(pipe.awaitingReplay).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the flush's end keeps a size taken before it", async () => {
    const ring = new RingBuffer(64 * 1024);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('prompt$ '));
    const pipe = await pipeWith(ring);
    // The desk's size arrives before its replay is out.
    ring.noteGeometry(118, 44, !pipe.awaitingReplay);
    expect(ring.geometryPending).toBe(true);

    const socket = await connectAuthed(pipe.getPipeName());
    cleanups.push(() => { socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);
    expect(ring.geometryPending).toBe(false);
    ring.noteGeometry(100, 30, !pipe.awaitingReplay);
    const { geometry } = ring.readAllWithGeometry();
    expect(geometry).toEqual({
      start: { cols: 80, rows: 24 },
      changes: [{ offset: 8, cols: 118, rows: 44 }, { offset: 8, cols: 100, rows: 30 }],
    });
  });

  it('a size taken before the replay is replaced by the next one', async () => {
    const ring = new RingBuffer(64 * 1024);
    ring.noteGeometry(118, 44);
    ring.write(Buffer.from('x'.repeat(10)));
    const pipe = await pipeWith(ring);
    ring.noteGeometry(122, 40, !pipe.awaitingReplay);
    ring.write(Buffer.from('repaint'));
    ring.noteGeometry(118, 44, !pipe.awaitingReplay);
    expect(ring.readAllWithGeometry().geometry).toEqual({ start: { cols: 118, rows: 44 }, changes: [] });
  });
});
