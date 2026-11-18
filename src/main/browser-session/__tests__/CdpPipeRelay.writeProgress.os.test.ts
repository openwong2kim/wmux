// writeProgress (the relay's drain sign for the stall watch) against a real
// socket handle on this OS: a WebSocket server sends one large frame to a
// client that reads it slowly, and the sign is read after each chunk the
// client takes. On macOS and Linux (a unix socket) it must rise while the
// frame is still being written. On Windows (a named pipe, and TCP, the
// relay's fallback) the sequence is only recorded: one log line prefixed
// `[writeProgress win32]`.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { writeProgress } from '../CdpPipeRelay';

const FRAME = 1 << 20;
const CHUNK = 16 << 10;

type Transport = 'unix' | 'pipe' | 'tcp';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
});

async function listen(server: Server, transport: Transport): Promise<net.NetConnectOpts> {
  if (transport === 'tcp') {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port };
  }
  let where: string;
  if (transport === 'pipe') {
    where = `\\\\.\\pipe\\wmux-write-progress-${randomBytes(6).toString('hex')}`;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    where = path.join(dir, 's');
  }
  await new Promise<void>((resolve) => server.listen(where, resolve));
  return { path: where };
}

/** Resolves once the client has bytes buffered to read, or has ended. */
function readable(client: net.Socket): Promise<void> {
  if (client.readableLength > 0 || client.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { client.off('readable', done); client.off('error', reject); resolve(); };
    client.once('readable', done);
    client.once('error', reject);
  });
}

/** One large frame to a client that reads it CHUNK by CHUNK; the drain sign before each read. */
async function measure(transport: Transport): Promise<Array<{ flushed: number; buffered: number }>> {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  const accepted = new Promise<{ ws: WebSocket; socket: Duplex }>((resolve) => {
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => resolve({ ws, socket })));
  });
  cleanups.push(() => { wss.close(); server.close(); });
  const target = await listen(server, transport);

  const client = net.connect(target);
  cleanups.push(() => client.destroy());
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  client.write(
    'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const { ws, socket } = await accepted;

  // The handshake answer first, read whole.
  let head = Buffer.alloc(0);
  while (!head.includes('\r\n\r\n')) {
    await readable(client);
    const got = client.read() as Buffer | null;
    if (got) head = Buffer.concat([head, got]);
  }
  let received = head.length - (head.indexOf('\r\n\r\n') + 4);

  // One frame: a 10-byte header and FRAME bytes of payload.
  ws.send(Buffer.alloc(FRAME, 0x61), { binary: true });
  const total = FRAME + 10;
  const seen: Array<{ flushed: number; buffered: number }> = [];
  while (received < total) {
    await readable(client);
    seen.push(writeProgress(ws, socket));
    const got = client.read(Math.min(CHUNK, client.readableLength)) as Buffer | null;
    if (got) received += got.length;
  }
  seen.push(writeProgress(ws, socket));
  return seen;
}

/** `value×count` runs, in KiB, for one log line. */
function runs(values: number[]): string {
  const out: string[] = [];
  for (const v of values) {
    const kib = Math.round(v / 1024);
    const last = out.at(-1);
    const [prev, count] = last ? last.split('×') : [];
    if (last && Number(prev) === kib) out[out.length - 1] = `${prev}×${Number(count) + 1}`;
    else out.push(`${kib}×1`);
  }
  return out.join(' ');
}

describe('writeProgress on a real socket handle', () => {
  if (process.platform === 'win32') {
    it.each(['pipe', 'tcp'] as const)('records the sequence on a %s (measured only)', async (transport) => {
      const seen = await measure(transport);
      console.log(
        `[writeProgress win32] ${transport} reads=${seen.length} flushedKiB=${runs(seen.map((s) => s.flushed))} bufferedKiB=${runs(seen.map((s) => s.buffered))}`,
      );
      expect(seen.length).toBeGreaterThan(0);
    });
  } else {
    it('rises while a large frame is read chunk by chunk over a unix socket', async () => {
      const seen = await measure('unix');
      const flushed = seen.map((s) => s.flushed);
      // Never backwards.
      for (let i = 1; i < flushed.length; i++) expect(flushed[i]).toBeGreaterThanOrEqual(flushed[i - 1]);
      // ws still holds the frame whole: its own count would show no progress.
      const mid = seen.filter((s) => s.buffered >= FRAME);
      expect(mid.length).toBeGreaterThan(1);
      // While it does, the handle's count rises step after step.
      const rises = mid.filter((s, i) => i > 0 && s.flushed > mid[i - 1].flushed).length;
      expect(rises).toBeGreaterThanOrEqual(3);
    });
  }
});
