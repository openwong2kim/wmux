// A pane stream whose viewer stops reading. Past PANE_STREAM_RESYNC_BYTES
// queued the server stops sending live output; when the viewer reads again it
// gets a fresh meta + snapshot pair cut from the ring (every byte it missed is
// in there), then live output again. Real HTTP over loopback, a real ring; the
// client is a raw socket so it can stop reading.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebTerminalServer, PANE_STREAM_RESYNC_BYTES } from '../WebTerminalServer';
import { RingBuffer } from '../../RingBuffer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

interface SseEvent { event: string; data: string }

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (event) events.push({ event, data });
  }
  return events;
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

let server: WebTerminalServer;
let ring: RingBuffer;
let bridge: EventEmitter;
let logs: string[];
let assetsDir: string;

beforeEach(() => {
  ring = new RingBuffer(1024 * 1024, 'node');
  bridge = new EventEmitter();
  logs = [];
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stream-resync-'));
  const managed = {
    meta: { id: 's1', incarnationId: 'i1', cols: 80, rows: 24, state: 'detached', cwd: '/x', spawnCwd: '/x' },
    deferred: false,
    viewerVisible: true,
    ringBuffer: ring,
    bridge,
    ptyProcess: { write: () => undefined },
  };
  const sessionManager = Object.assign(new EventEmitter(), {
    getSession: (id: string) => (id === 's1' ? managed : undefined),
    listLiveSessions: () => [],
    activateDeferred: () => undefined,
  }) as unknown as DaemonSessionManager;
  server = new WebTerminalServer({ sessionManager, log: (_level: string, line: string) => { logs.push(line); }, assetsDir });
});

afterEach(async () => {
  await server.stop();
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

/** The pane prints: into the ring first, then to live listeners, as the session manager does. */
function paneWrites(text: string): void {
  const chunk = Buffer.from(text);
  ring.write(chunk);
  bridge.emit('data', chunk);
}

/** Open the pane stream on a raw socket; `received` collects everything read. */
async function openStream(token: string, port: number): Promise<{ socket: net.Socket; received: () => string }> {
  const socket = net.connect(port, '127.0.0.1');
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (c: string) => { buf += c; });
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write(`GET /api/stream?session=s1&token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`);
  await expect.poll(() => buf.includes('event: snapshot'), { timeout: 10_000 }).toBe(true);
  return { socket, received: () => buf };
}

/** Flood the pane while the viewer reads nothing, until the server reports it fell behind. */
async function floodUntilBehind(lines: { n: number }): Promise<void> {
  await floodUntilBehindTimes(lines, 1);
}

/** Flood until the server has reported falling behind `times` times in all. */
async function floodUntilBehindTimes(lines: { n: number }, times: number): Promise<void> {
  for (let round = 0; round < 4000 && logs.filter((l) => l.includes('fell behind')).length < times; round++) {
    let text = '';
    for (let i = 0; i < 400; i++) text += `line-${lines.n++} ${'x'.repeat(60)}\r\n`;
    paneWrites(text);
    await tick();
  }
}

describe('pane stream with a viewer that stops reading', () => {
  it('stops queueing at the bound and repaints the viewer from the ring when it reads again', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const { socket, received } = await openStream(info.token as string, info.port as number);
    socket.pause();

    const lines = { n: 0 };
    await floodUntilBehind(lines);
    const behind = logs.find((l) => l.includes('fell behind'));
    expect(behind).toBeDefined();
    const queued = Number(/\((\d+) bytes queued\)/.exec(behind!)![1]);
    expect(queued).toBeGreaterThan(PANE_STREAM_RESYNC_BYTES);
    // At most the bound plus the one frame that crossed it.
    expect(queued).toBeLessThan(PANE_STREAM_RESYNC_BYTES + 64 * 1024);

    // Keep printing while the viewer is behind: none of it is queued.
    for (let i = 0; i < 50; i++) {
      paneWrites(`behind-${i} ${'y'.repeat(60)}\r\n`);
      await tick();
    }
    const lastBehind = 'behind-49';
    expect(logs.filter((l) => l.includes('fell behind'))).toHaveLength(1);

    socket.resume();
    await expect.poll(() => logs.some((l) => l.includes('caught up')), { timeout: 20_000 }).toBe(true);
    paneWrites('after-resync\r\n');
    await expect.poll(() => received().includes(Buffer.from('after-resync\r\n').toString('base64')), { timeout: 10_000 }).toBe(true);
    socket.destroy();

    const events = parseSse(received());
    const snapshots = events.map((e, i) => ({ ...e, i })).filter((e) => e.event === 'snapshot');
    expect(snapshots).toHaveLength(2);
    // The repaint is a full meta + snapshot pair, which every client takes as a start-over.
    const repaintMeta = events[snapshots[1].i - 1];
    expect(repaintMeta.event).toBe('meta');
    expect(JSON.parse(repaintMeta.data).resize).toBeUndefined();
    // It carries what the viewer missed, up to the last line printed while it was behind.
    expect(decode(snapshots[1].data)).toContain(lastBehind);
    // Live output resumes after it, and only after it.
    const live = events.slice(snapshots[1].i + 1).filter((e) => e.event === 'data').map((e) => decode(e.data));
    expect(live).toEqual(['after-resync\r\n']);
    // What the pane printed while the viewer was behind never went out as live frames.
    const sentLive = events.slice(0, snapshots[1].i).filter((e) => e.event === 'data').map((e) => decode(e.data)).join('');
    expect(sentLive).not.toContain('behind-');
    expect(logs.some((l) => l.includes('response queue limit exceeded'))).toBe(false);
  }, 60_000);

  it('falls behind and catches up again; the second repaint inside the render interval comes from the raw window', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const { socket, received } = await openStream(info.token as string, info.port as number);
    const lines = { n: 0 };
    for (const round of [1, 2]) {
      socket.pause();
      await floodUntilBehindTimes(lines, round);
      paneWrites(`end-of-round-${round}\r\n`);
      socket.resume();
      await expect.poll(() => logs.filter((l) => l.includes('caught up')).length, { timeout: 20_000 }).toBe(round);
    }
    paneWrites('after-both\r\n');
    await expect.poll(() => received().includes(Buffer.from('after-both\r\n').toString('base64')), { timeout: 10_000 }).toBe(true);
    socket.destroy();

    const snapshots = parseSse(received()).filter((e) => e.event === 'snapshot').map((e) => decode(e.data));
    expect(snapshots).toHaveLength(3);
    expect(snapshots[1]).toContain('end-of-round-1');
    expect(snapshots[2]).toContain('end-of-round-2');
    expect(logs.some((l) => l.includes('response queue limit exceeded'))).toBe(false);
  }, 60_000);

  it('sends an exit seen while the viewer was behind after the repaint', async () => {
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false });
    const { socket, received } = await openStream(info.token as string, info.port as number);
    socket.pause();
    await floodUntilBehind({ n: 0 });

    paneWrites('last words\r\n');
    bridge.emit('exit');
    socket.resume();
    await expect.poll(() => received().includes('event: exit'), { timeout: 20_000 }).toBe(true);
    socket.destroy();

    const events = parseSse(received());
    const lastSnapshot = events.map((e) => e.event).lastIndexOf('snapshot');
    const exit = events.map((e) => e.event).indexOf('exit');
    expect(lastSnapshot).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(lastSnapshot);
    expect(decode(events[lastSnapshot].data)).toContain('last words');
  }, 60_000);
});
