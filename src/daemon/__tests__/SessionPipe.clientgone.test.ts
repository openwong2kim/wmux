import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { SessionPipe } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';

// ── helpers ─────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, deadlineMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > deadlineMs) throw new Error('waitFor: deadline exceeded');
    await sleep(5);
  }
}

function uniqueSessionId(tag: string): string {
  return `clientgone-${tag}-${crypto.randomUUID().slice(0, 8)}`;
}

const TOKEN = 'clientgone-session-token';

/** Connect and complete the auth handshake by sending the token line. */
function connectAuthed(pipeName: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(pipeName, () => {
      socket.write(TOKEN + '\n');
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

/** Connect WITHOUT sending the token — stays in the pre-auth state. */
function connectRaw(pipeName: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(pipeName, () => resolve(socket));
    socket.on('error', reject);
  });
}

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      /* best-effort */
    }
  }
  cleanups = [];
});

describe('SessionPipe — client presence + onClientGone (#557)', () => {
  it('hasClient() tracks the auth lifecycle', async () => {
    const pipe = new SessionPipe(uniqueSessionId('haslient'), new RingBuffer(64 * 1024), TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    expect(pipe.hasClient()).toBe(false);

    const socket = await connectAuthed(pipe.getPipeName());
    cleanups.push(() => { socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);
    expect(pipe.hasClient()).toBe(true);

    socket.destroy();
    await waitFor(() => !pipe.hasClient(), 3000);
    expect(pipe.hasClient()).toBe(false);
  });

  it('fires onClientGone when an authed client socket closes', async () => {
    const pipe = new SessionPipe(uniqueSessionId('close'), new RingBuffer(64 * 1024), TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    let fired = 0;
    pipe.onClientGone = () => { fired++; };

    const socket = await connectAuthed(pipe.getPipeName());
    cleanups.push(() => { socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);

    socket.destroy();
    await waitFor(() => fired > 0, 3000);
    expect(fired).toBe(1);
  });

  it('does NOT fire onClientGone for a pre-auth socket close', async () => {
    const pipe = new SessionPipe(uniqueSessionId('preauth'), new RingBuffer(64 * 1024), TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    let fired = 0;
    pipe.onClientGone = () => { fired++; };

    // Connect but never send the token, then drop the socket.
    const socket = await connectRaw(pipe.getPipeName());
    await sleep(20); // let the daemon accept + register the pre-auth client
    socket.destroy();

    // Give the close event time to propagate; onClientGone must stay silent.
    await sleep(150);
    expect(fired).toBe(0);
    expect(pipe.hasClient()).toBe(false);
  });
});
