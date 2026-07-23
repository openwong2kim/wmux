// TASK-10 — initial-attach snapshot flush (perf plan 2026-07-22, decision D2).
//
// The attach flush used to ship the whole ring buffer raw (up to 8 MB the
// renderer parses synchronously on reveal). With a dims provider and a large
// buffer, SessionPipe now serializes daemon-side via HeadlessSnapshot and
// ships the compact ANSI instead. These tests pin the protocol contract:
//   1. large buffer + dims → snapshot payload (much smaller), FLUSH_DONE, and
//      SCREEN PARITY with the raw replay (headless re-parse of both match)
//   2. small buffer → raw passthrough byte-identical to before
//   3. no dims provider (legacy ctor) → raw passthrough regardless of size
//   4. alt-screen content → fail-open raw (HeadlessSnapshot refuses)
//   5. live bytes written DURING the parse arrive after the snapshot (delta
//      re-read), before FLUSH_DONE — no gap, no reorder
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SessionPipe, FLUSH_DONE_MARKER, ATTACH_SNAPSHOT_MIN_BYTES } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';

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
  return `attsnap-${tag}-${crypto.randomUUID().slice(0, 8)}`;
}

interface Client {
  socket: net.Socket;
  wire: () => Buffer;
}

function connectClient(pipeName: string, token: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(pipeName, () => {
      socket.write(token + '\n');
      resolve({ socket, wire: () => Buffer.concat(chunks) });
    });
    socket.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.on('error', reject);
  });
}

/** Everything the client received before FLUSH_DONE_MARKER. */
function replaySegment(wire: Buffer): Buffer | null {
  const at = wire.indexOf(FLUSH_DONE_MARKER);
  return at === -1 ? null : wire.subarray(0, at);
}

/** Parse ANSI through a headless terminal and dump visible screen rows. */
async function screenOf(data: Buffer, cols: number, rows: number): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  try {
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    }
    return lines;
  } finally {
    term.dispose();
  }
}

/** Parse ANSI and return EVERY buffer row (scrollback + viewport), trimmed. */
async function fullBufferText(data: Buffer, cols: number, rows: number, scrollback: number): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  try {
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return lines;
  } finally {
    term.dispose();
  }
}

/** ≥ threshold of plausible shell traffic: numbered lines + SGR + CJK. */
function bigHistory(minBytes: number): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  for (let i = 0; total < minBytes; i++) {
    const line = `\x1b[3${i % 8}mline ${i} 한글출력 ${'x'.repeat(40)}\x1b[0m\r\n`;
    const b = Buffer.from(line, 'utf8');
    parts.push(b);
    total += b.length;
  }
  return Buffer.concat(parts);
}

/** Redraw-heavy history (progress bars / TUI repaints): each iteration clears
 *  and repaints the same small screen, so the FINAL state is a handful of rows
 *  however many megabytes were written. This is the compression the snapshot
 *  path exists for — independent of scrollback depth (unlike pure-append
 *  history, which under MAX_SCROLLBACK retains every line and does not shrink). */
function redrawHistory(minBytes: number): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  for (let i = 0; total < minBytes; i++) {
    const frame = `\x1b[H\x1b[2Jprogress ${i % 100}%\r\n\x1b[3${i % 8}mstatus line 한글 ${'.'.repeat(60)}\x1b[0m`;
    const b = Buffer.from(frame, 'utf8');
    parts.push(b);
    total += b.length;
  }
  return Buffer.concat(parts);
}

const TOKEN = 'attsnap-test-token';
const COLS = 100;
const ROWS = 24;

const pipes: SessionPipe[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.destroy();
  for (const p of pipes.splice(0)) await p.stop().catch(() => {});
});

async function startPipe(
  id: string,
  ring: RingBuffer,
  dims?: () => { cols: number; rows: number },
): Promise<SessionPipe> {
  const pipe = new SessionPipe(id, ring, TOKEN, dims);
  pipes.push(pipe);
  await pipe.start();
  return pipe;
}

describe('SessionPipe initial-attach snapshot (TASK-10)', () => {
  it('large buffer + dims → compact snapshot with screen parity, then FLUSH_DONE', async () => {
    // Redraw-heavy history (4× the threshold): the repaints collapse to a few
    // final rows, the real big-ring shape this path exists for. (Pure-append
    // history now retains every line under MAX_SCROLLBACK and takes the no-gain
    // raw fallback instead — see the 'preserves history' test below.)
    const raw = redrawHistory(ATTACH_SNAPSHOT_MIN_BYTES * 4);
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const pipe = await startPipe(uniqueSessionId('big'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 15_000);

    const replay = replaySegment(client.wire());
    expect(replay).not.toBeNull();
    // The whole point: dramatically fewer bytes than the raw history.
    expect(replay!.length).toBeLessThan(raw.length / 2);
    // Fidelity: the serialized replay reconstructs the same visible screen
    // as parsing the full raw stream (the plan's "correct screen state" AC,
    // CJK included via the Unicode11 parity in HeadlessSnapshot).
    const [fromSnapshot, fromRaw] = await Promise.all([
      screenOf(replay!, COLS, ROWS),
      screenOf(raw, COLS, ROWS),
    ]);
    expect(fromSnapshot).toEqual(fromRaw);
  });

  it('history that fits scrollback (no compression win) → no-gain raw fallback', async () => {
    // Just past the threshold every line is still inside the serialized
    // scrollback window — the snapshot can serialize LARGER than raw. The
    // size guard must ship raw, byte-identical.
    const raw = bigHistory(ATTACH_SNAPSHOT_MIN_BYTES);
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const pipe = await startPipe(uniqueSessionId('nogain'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 15_000);

    const replay = replaySegment(client.wire())!;
    // Either the guard shipped raw verbatim, or (if serialize happened to
    // come out smaller on this content) the snapshot must not exceed raw.
    expect(replay.length).toBeLessThanOrEqual(raw.length);
    if (replay.length === raw.length) {
      expect(replay.equals(raw)).toBe(true);
    }
  });

  it('small buffer → raw bytes pass through unchanged', async () => {
    const raw = Buffer.from('tiny session \x1b[32mgreen\x1b[0m\r\n', 'utf8');
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const pipe = await startPipe(uniqueSessionId('small'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 5_000);

    expect(replaySegment(client.wire())!.equals(raw)).toBe(true);
  });

  it('no dims provider (legacy ctor) → raw passthrough even for large buffers', async () => {
    const raw = bigHistory(ATTACH_SNAPSHOT_MIN_BYTES);
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const pipe = await startPipe(uniqueSessionId('nodims'), ring);

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 15_000);

    expect(replaySegment(client.wire())!.equals(raw)).toBe(true);
  });

  it('alt-screen history → fail-open raw replay', async () => {
    // Enter the alternate screen (vim-style) and stay there: HeadlessSnapshot
    // must refuse and the flush must ship the raw bytes.
    const raw = Buffer.concat([
      bigHistory(ATTACH_SNAPSHOT_MIN_BYTES),
      Buffer.from('\x1b[?1049h\x1b[2Jvim-ish full screen content', 'utf8'),
    ]);
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const pipe = await startPipe(uniqueSessionId('alt'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 15_000);

    expect(replaySegment(client.wire())!.equals(raw)).toBe(true);
  });

  it('bytes arriving DURING the parse ship as a delta before FLUSH_DONE', async () => {
    const raw = bigHistory(ATTACH_SNAPSHOT_MIN_BYTES * 2); // longer parse window
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    // While the snapshot builds (flushed=false), live PTY output goes to the
    // ring only — exactly what the daemon's data path does. Inject the marker
    // right after the flush's first (pre-parse) readAll so it is deterministically
    // in the ring during the parse; a wall-clock sleep raced the shared
    // concurrency-1 snapshot queue and flaked on slower CI runners (macos-14).
    const liveMarker = Buffer.from('\r\nLIVE-DELTA-MARKER-9f2\r\n', 'utf8');
    injectAfterFirstReadAll(ring, liveMarker);
    const pipe = await startPipe(uniqueSessionId('delta'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);

    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 20_000);
    const replay = replaySegment(client.wire())!;
    // The delta rides inside the replay segment (before FLUSH_DONE), after
    // the serialized snapshot — appended, never lost.
    expect(replay.includes(liveMarker)).toBe(true);
    expect(replay.length).toBeLessThan(raw.length); // still a snapshot, not raw
  });

  // Deterministic mid-parse injection: the attach flush reads the ring once
  // BEFORE the parse (`buffered`) and again AFTER (the delta re-read). Hooking
  // the first readAll to append the live bytes right after it returns guarantees
  // the delta is in the ring during the parse without racing a wall-clock sleep
  // (which the shared concurrency-1 snapshot queue makes flaky).
  function injectAfterFirstReadAll(ring: RingBuffer, liveMarker: Buffer): void {
    const origReadAll = ring.readAll.bind(ring);
    let injected = false;
    (ring as unknown as { readAll: () => Buffer }).readAll = () => {
      const out = origReadAll();
      if (!injected) {
        injected = true;
        ring.write(liveMarker);
      }
      return out;
    };
  }

  it('attach snapshot preserves history beyond the 5000-line default', async () => {
    // 8000 uniquely-numbered lines: the pre-fix DEFAULT_SCROLLBACK=5000 would
    // drop the oldest ~3000 from a serialized snapshot; the flush now requests
    // MAX_SCROLLBACK so the full history survives (parity with the renderer's
    // configurable 10k xterm scrollback).
    const parts: Buffer[] = [];
    for (let i = 0; i < 8000; i++) {
      parts.push(Buffer.from(`LINE-${String(i).padStart(6, '0')} ${'x'.repeat(30)}\r\n`, 'utf8'));
    }
    const raw = Buffer.concat(parts);
    expect(raw.length).toBeGreaterThan(ATTACH_SNAPSHOT_MIN_BYTES);
    const ring = new RingBuffer(16 * 1024 * 1024);
    ring.write(raw);
    const pipe = await startPipe(uniqueSessionId('scrollback'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 20_000);

    const replay = replaySegment(client.wire())!;
    const lines = await fullBufferText(replay, COLS, ROWS, 50_000);
    const joined = lines.join('\n');
    // The oldest lines (well beyond 5000 from the bottom) are still present.
    expect(joined).toContain('LINE-000000');
    expect(joined).toContain('LINE-002000');
    // Count surviving distinct markers to prove > 5000 lines round-tripped.
    const survived = lines.filter((l) => /^LINE-\d{6}/.test(l)).length;
    expect(survived).toBeGreaterThan(5000);
  });

  it('live delta during a FAILED parse (alt-screen) is not dropped', async () => {
    // Alt-screen forces the snapshot to fail → the raw fallback branch. The fix
    // re-reads the ring there, so bytes written while the (doomed) parse ran are
    // retransmitted instead of silently lost until the next resync.
    const raw = Buffer.concat([
      bigHistory(ATTACH_SNAPSHOT_MIN_BYTES),
      Buffer.from('\x1b[?1049h\x1b[2Jvim-ish full screen content', 'utf8'),
    ]);
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const liveMarker = Buffer.from('\r\nLIVE-DELTA-FAIL-7c1\r\n', 'utf8');
    injectAfterFirstReadAll(ring, liveMarker);
    const pipe = await startPipe(uniqueSessionId('delta-fail'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 20_000);
    const replay = replaySegment(client.wire())!;
    // Raw fallback ships the full re-read: the original history is a prefix and
    // the live delta rides at the tail — nothing dropped.
    expect(replay.subarray(0, raw.length).equals(raw)).toBe(true);
    expect(replay.includes(liveMarker)).toBe(true);
  });

  it('live delta during a NO-GAIN parse is not dropped', async () => {
    // Plain ASCII that fits inside the serialized scrollback window: the cell
    // reconstruction is no smaller than raw, so the size guard takes the no-gain
    // raw branch. The fix re-reads the ring there too, so the mid-parse delta is
    // retransmitted rather than dropped.
    const parts: Buffer[] = [];
    for (let i = 0; parts.reduce((n, b) => n + b.length, 0) < ATTACH_SNAPSHOT_MIN_BYTES; i++) {
      parts.push(Buffer.from(`plain line ${i} ${'.'.repeat(48)}\r\n`, 'utf8'));
    }
    const raw = Buffer.concat(parts);
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(raw);
    const liveMarker = Buffer.from('\r\nLIVE-DELTA-NOGAIN-4b8\r\n', 'utf8');
    injectAfterFirstReadAll(ring, liveMarker);
    const pipe = await startPipe(uniqueSessionId('delta-nogain'), ring, () => ({ cols: COLS, rows: ROWS }));

    const client = await connectClient(pipe.getPipeName(), TOKEN);
    clients.push(client);
    await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 20_000);
    const replay = replaySegment(client.wire())!;
    // Whichever raw branch (no-gain here) or the snapshot-delta path was taken,
    // the delta must be present — that is the regression under test.
    expect(replay.includes(liveMarker)).toBe(true);
  });
});
