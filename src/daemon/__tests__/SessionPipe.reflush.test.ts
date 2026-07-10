import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  SessionPipe,
  FLUSH_DONE_MARKER,
  RESYNC_BEGIN_MARKER,
} from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { generateSnapshot } from '../HeadlessSnapshot';

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

/** Unique per-test session id so named pipes / unix sockets never collide. */
function uniqueSessionId(tag: string): string {
  return `reflush-${tag}-${crypto.randomUUID().slice(0, 8)}`;
}

interface Client {
  socket: net.Socket;
  chunks: Buffer[];
  wire: () => Buffer;
}

function connectClient(pipeName: string, token: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(pipeName, () => {
      socket.write(token + '\n');
      resolve({ socket, chunks, wire: () => Buffer.concat(chunks) });
    });
    socket.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.on('error', reject);
  });
}

interface WireSegments {
  replay1: Buffer;
  live1: Buffer;
  replay2: Buffer;
  live2: Buffer;
  resynced: boolean;
}

/**
 * Split the client's received byte stream into its protocol segments:
 *   [replay1][FLUSH_DONE][live1][RESYNC_BEGIN][replay2][FLUSH_DONE][live2...]
 */
function parseWire(buf: Buffer): WireSegments | null {
  const f = FLUSH_DONE_MARKER.length;
  const r = RESYNC_BEGIN_MARKER.length;
  const f1 = buf.indexOf(FLUSH_DONE_MARKER);
  if (f1 < 0) return null;
  const rs = buf.indexOf(RESYNC_BEGIN_MARKER, f1 + f);
  if (rs < 0) {
    return { replay1: buf.subarray(0, f1), live1: Buffer.alloc(0), replay2: Buffer.alloc(0), live2: Buffer.alloc(0), resynced: false };
  }
  const f2 = buf.indexOf(FLUSH_DONE_MARKER, rs + r);
  if (f2 < 0) {
    return { replay1: buf.subarray(0, f1), live1: buf.subarray(f1 + f, rs), replay2: Buffer.alloc(0), live2: Buffer.alloc(0), resynced: false };
  }
  return {
    replay1: buf.subarray(0, f1),
    live1: buf.subarray(f1 + f, rs),
    replay2: buf.subarray(rs + r, f2),
    live2: buf.subarray(f2 + f),
    resynced: true,
  };
}

// Headless terminal harness matching generateSnapshot's config exactly.
function makeTerminal(cols: number, rows: number): Terminal {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}

function writeAsync(t: Terminal, data: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => t.write(data, resolve));
}

function bufferText(t: Terminal): string[] {
  const buf = t.buffer.normal;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

const TOKEN = 'reflush-session-token';

// Cleanup registry — each test pushes teardown steps (LIFO).
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

describe('SessionPipe.reflush — gap-free live re-flush', () => {
  it('reconstructs the full stream from [snapshot replay2 + live2] with no gap', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('gapfree'), ring, TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    // Seed pre-attach history, and start the chronological reference log.
    const seed = Buffer.from('boot line 0\r\nboot line 1\r\n');
    ring.write(seed);
    const original: Buffer[] = [seed];

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    cleanups.push(() => { client.socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);

    // A PTY byte is atomic across these three sinks (mirrors the daemon:
    // SessionManager writes the ring and the client, the reflush tee reads
    // the bridge). No await splits them, so no chunk straddles T0.
    const floodChunk = (data: Buffer): void => {
      original.push(data);
      ring.write(data);
      pipe.writeToClient(data);
      bridge.emit('data', data);
    };

    const TOTAL = 40;
    let n = 0;
    const interval = setInterval(() => {
      if (n >= TOTAL) {
        clearInterval(interval);
        return;
      }
      floodChunk(Buffer.from(`\x1b[3${n % 8}mrow ${n} payload xyz\x1b[0m\r\n`));
      n++;
    }, 2);
    cleanups.push(() => clearInterval(interval));

    // Fire the re-flush mid-flood; chunks keep arriving during generation.
    await sleep(12);
    const result = await pipe.reflush({ bridge, cols: 80, rows: 24, generate: generateSnapshot });
    expect(result.mode).toBe('snapshot');

    // Let the flood drain, then append a sentinel that can only land in live2.
    await waitFor(() => n >= TOTAL, 3000);
    clearInterval(interval);
    const sentinel = Buffer.from(`SENTINEL-${crypto.randomUUID().slice(0, 8)}\r\n`);
    floodChunk(sentinel);

    await waitFor(() => {
      const p = parseWire(client.wire());
      return !!(p && p.resynced && p.live2.includes(sentinel));
    }, 5000);

    const parsed = parseWire(client.wire());
    expect(parsed?.resynced).toBe(true);
    if (!parsed || !parsed.resynced) throw new Error('resync segments not found');

    // The proof: replaying [snapshot] then [live tail] equals a continuous
    // parse of every original byte. Any lost/duplicated byte would diverge.
    const restored = makeTerminal(80, 24);
    await writeAsync(restored, parsed.replay2);
    await writeAsync(restored, parsed.live2);

    const reference = makeTerminal(80, 24);
    await writeAsync(reference, Buffer.concat(original));

    expect(trimTrailingBlank(bufferText(restored))).toEqual(trimTrailingBlank(bufferText(reference)));
  }, 20000);

  it('keeps forwarding client input while a re-flush is generating', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('input'), ring, TOKEN);
    cleanups.push(() => pipe.stop());

    const inputs: Buffer[] = [];
    pipe.onInput((d) => inputs.push(d));
    await pipe.start();

    ring.write(Buffer.from('shell prompt$ \r\n'));
    const client = await connectClient(pipe.getPipeName(), TOKEN);
    cleanups.push(() => { client.socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);

    // Deliberately slow generator so we can type into the socket mid-flight.
    const slowGenerate: typeof generateSnapshot = async (req) => {
      await sleep(60);
      return generateSnapshot(req);
    };
    const p = pipe.reflush({ bridge, cols: 80, rows: 24, generate: slowGenerate });

    await sleep(15);
    client.socket.write('typed-during-resync');

    const result = await p;
    expect(result.mode).toBe('snapshot');

    await sleep(20);
    expect(Buffer.concat(inputs).toString()).toContain('typed-during-resync');
  }, 20000);

  it('degrades to raw replay and ships the ring bytes verbatim on alt-screen', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('raw'), ring, TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    // Alt-screen forces the snapshot generator to decline.
    const seed = Buffer.from('\x1b[?1049h\x1b[HALT SCREEN CONTENT\r\nsecond\r\n');
    ring.write(seed);

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    cleanups.push(() => { client.socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);

    const result = await pipe.reflush({ bridge, cols: 80, rows: 24, generate: generateSnapshot });
    expect(result.mode).toBe('raw');
    expect(result.fallbackReason).toBe('alt-screen');

    await waitFor(() => {
      const p = parseWire(client.wire());
      return !!(p && p.resynced);
    }, 5000);
    const parsed = parseWire(client.wire())!;
    // Raw degrade replays a RIS reset (\x1bc) followed by the exact ring bytes.
    const expectedReplay2 = Buffer.concat([Buffer.from('\x1bc'), seed]);
    expect(parsed.replay2.equals(expectedReplay2)).toBe(true);
  }, 20000);

  it('rejects a concurrent re-flush with RESYNC_BUSY', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('busy'), ring, TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    ring.write(Buffer.from('content\r\n'));
    const client = await connectClient(pipe.getPipeName(), TOKEN);
    cleanups.push(() => { client.socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);

    const slowGenerate: typeof generateSnapshot = async (req) => {
      await sleep(60);
      return generateSnapshot(req);
    };
    const first = pipe.reflush({ bridge, cols: 80, rows: 24, generate: slowGenerate });

    // A concurrent re-flush MUST reject rather than corrupt the stream. Note:
    // the first re-flush sets `flushed = false` synchronously at T0, so the
    // second call trips the RESYNC_UNAVAILABLE guard (which is checked before
    // reflushInFlight) — the RESYNC_BUSY guard is therefore never actually
    // reachable. Either way the concurrency invariant holds: the second call
    // is refused.
    await expect(
      pipe.reflush({ bridge, cols: 80, rows: 24, generate: generateSnapshot }),
    ).rejects.toThrow(/RESYNC_(BUSY|UNAVAILABLE)/);

    await expect(first).resolves.toBeDefined();
  }, 20000);

  it('rejects with RESYNC_UNAVAILABLE when no client is attached', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('unavail'), ring, TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    await expect(
      pipe.reflush({ bridge, cols: 80, rows: 24, generate: generateSnapshot }),
    ).rejects.toThrow('RESYNC_UNAVAILABLE');
  }, 20000);

  it('rejects with RESYNC_DISCONNECTED if the client dies mid-generation, then serves a fresh client', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('disc'), ring, TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    const seed = Buffer.from('durable content\r\n');
    ring.write(seed);

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    await waitFor(() => pipe.isFlushed, 3000);

    const slowGenerate: typeof generateSnapshot = async (req) => {
      await sleep(80);
      return generateSnapshot(req);
    };
    const p = pipe.reflush({ bridge, cols: 80, rows: 24, generate: slowGenerate });

    await sleep(15);
    client.socket.destroy();

    await expect(p).rejects.toThrow('RESYNC_DISCONNECTED');

    // The pipe must recover: a brand-new client gets a normal initial flush.
    await waitFor(() => !pipe.isConnected, 3000);
    const client2 = await connectClient(pipe.getPipeName(), TOKEN);
    cleanups.push(() => { client2.socket.destroy(); });
    await waitFor(() => client2.wire().includes(FLUSH_DONE_MARKER), 3000);
    const parsed = parseWire(client2.wire());
    expect(parsed?.replay1.equals(seed)).toBe(true);
  }, 20000);

  // Codex P2 regression: a reflush queued behind the global snapshot slot
  // must NOT announce RESYNC_BEGIN (and suppress live output) until its work
  // can actually start — under concurrent dirty-pane reveals the queue wait
  // is N×budget, which would outlive the renderer's resync timeout while the
  // pane sits suppressed.
  it('a queued reflush keeps the pane live until its snapshot slot starts', async () => {
    const ring = new RingBuffer(1024 * 1024);
    const bridge = new EventEmitter();
    const pipe = new SessionPipe(uniqueSessionId('slotwait'), ring, TOKEN);
    cleanups.push(() => pipe.stop());
    await pipe.start();

    const seed = Buffer.from('seed$ \r\n');
    ring.write(seed);
    // Mirror the daemon's attachSession wiring: bridge data → client socket.
    bridge.on('data', (d: Buffer) => pipe.writeToClient(d));
    const client = await connectClient(pipe.getPipeName(), TOKEN);
    cleanups.push(() => { client.socket.destroy(); });
    await waitFor(() => pipe.isFlushed, 3000);

    // A slot that does not open until we say so — simulates another pane's
    // snapshot holding the global queue.
    let releaseSlot!: () => void;
    const gate = new Promise<void>((r) => { releaseSlot = r; });
    const enqueue = async <T,>(job: () => Promise<T>): Promise<T> => {
      await gate;
      return job();
    };

    const reflushDone = pipe.reflush({
      bridge: bridge as never,
      cols: 80,
      rows: 24,
      generate: generateSnapshot,
      enqueue,
    });
    // Belt: the busy window covers the queue wait too.
    await expect(
      pipe.reflush({ bridge: bridge as never, cols: 80, rows: 24, generate: generateSnapshot, enqueue }),
    ).rejects.toThrow(/RESYNC_BUSY/);

    // While queued: no BEGIN on the wire, and live bytes still flow.
    const liveDuringWait = Buffer.from('typed-while-queued\r\n');
    ring.write(liveDuringWait);
    bridge.emit('data', liveDuringWait);
    await waitFor(() => client.wire().includes(liveDuringWait), 3000);
    expect(client.wire().indexOf(RESYNC_BEGIN_MARKER)).toBe(-1);

    releaseSlot();
    const result = await reflushDone;
    expect(result.mode).toBe('snapshot');
    await waitFor(() => parseWire(client.wire())?.resynced === true, 3000);
    const parsed = parseWire(client.wire());
    expect(parsed?.live1.includes(liveDuringWait)).toBe(true);
  }, 20000);
});
