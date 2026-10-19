// #1843 — a reattach after the ring wraps must restore the modes a fullscreen
// TUI switched on at startup.
//
// Codex (like vim, htop, Claude Code fullscreen) sends `?1049h` plus mouse,
// focus and bracketed-paste modes ONCE, then repaints by absolute positioning.
// After more output than the 8 MB ring holds, those bytes are gone, and a
// replay of the ring alone left the renderer on the normal buffer with mouse
// tracking off: the wheel scrolled an empty xterm scrollback instead of
// reaching the app. SessionPipe now leads every replay with the session's
// output-mode preamble.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Terminal } from '@xterm/headless';
import { SessionPipe, createSessionPipeMarkers, ATTACH_SNAPSHOT_MIN_BYTES } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { generateSnapshotUnqueued } from '../HeadlessSnapshot';
import { waitFor } from '../../test-utils/waitFor';

const TOKEN = 'mode-preamble-test-token';
const MARKERS = createSessionPipeMarkers(TOKEN);
const COLS = 100;
const ROWS = 30;
const RING_BYTES = 8 * 1024 * 1024;
const ALT_ON = '\x1b[?1049h';

/** What codex-cli 0.160 switches on at startup (captured from a real PTY). */
const CODEX_STARTUP = `${ALT_ON}\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h`;

/** One synchronized, absolutely positioned full-screen frame. */
function codexFrame(i: number): string {
  let f = '\x1b[?2026h\x1b[H';
  for (let r = 1; r <= ROWS; r++) f += `\x1b[${r};1H\x1b[2Kframe ${i} row ${r} ${'·'.repeat(40)}`;
  return f + '\x1b[?2026l';
}

interface Session {
  ring: RingBuffer;
  tracker: OutputModeTracker;
  write(text: string): void;
}

/** A ring and the tracker fed alongside it, as DaemonPTYBridge does. */
function session(): Session {
  const ring = new RingBuffer(RING_BYTES);
  const tracker = new OutputModeTracker();
  return {
    ring,
    tracker,
    write(text) {
      ring.write(Buffer.from(text, 'utf8'));
      tracker.feed(text, ring.totalBytesWritten);
    },
  };
}

/** Codex started, then painted `minBytes` of frames. */
function codexSession(minBytes: number): Session {
  const s = session();
  s.write(CODEX_STARTUP);
  for (let i = 0; s.ring.totalBytesWritten < minBytes; i++) s.write(codexFrame(i));
  return s;
}

const pipes: SessionPipe[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const p of pipes.splice(0)) await p.stop().catch(() => undefined);
});

async function attach(s: Session, withModes = true): Promise<{ pipe: SessionPipe; wire: () => Buffer }> {
  const pipe = new SessionPipe(
    `modepre-${crypto.randomUUID().slice(0, 8)}`,
    s.ring,
    TOKEN,
    () => ({ cols: COLS, rows: ROWS }),
    withModes ? () => s.tracker : undefined,
  );
  pipes.push(pipe);
  await pipe.start();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(pipe.getPipeName(), () => {
      socket.write(TOKEN + '\n');
      resolve();
    });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    sockets.push(socket);
  });
  const wire = () => Buffer.concat(chunks);
  await waitFor(() => wire().includes(MARKERS.flushDone), 30_000);
  return { pipe, wire };
}

function between(wire: Buffer, start: Buffer | null, end: Buffer): Buffer {
  const from = start ? wire.indexOf(start) + start.length : 0;
  return wire.subarray(from, wire.indexOf(end, from));
}

function count(hay: Buffer, needle: string): number {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n++;
  return n;
}

/** The mode state a renderer ends up in after parsing `replay`. */
async function modesAfter(replay: Buffer) {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(replay, resolve));
    return {
      buffer: term.buffer.active.type,
      mouse: term.modes.mouseTrackingMode,
      paste: term.modes.bracketedPasteMode,
      focus: term.modes.sendFocusMode,
    };
  } finally {
    term.dispose();
  }
}

const CODEX_MODES = { buffer: 'alternate', mouse: 'any', paste: true, focus: true };

describe('SessionPipe replays lead with the output-mode preamble (#1843)', () => {
  it('attach after 9 MB of Codex output restores alt screen, mouse, paste and focus', async () => {
    const s = codexSession(9 * 1024 * 1024);
    // The premise: the ring no longer carries Codex's startup switch.
    expect(s.ring.readAll().includes(ALT_ON)).toBe(false);

    const { wire } = await attach(s);
    const replay = between(wire(), null, MARKERS.flushDone);

    expect(await modesAfter(replay)).toEqual(CODEX_MODES);
    expect(count(replay, ALT_ON)).toBe(1);
  }, 60_000);

  it('a re-flush after 9 MB of Codex output restores the same modes', async () => {
    const s = codexSession(9 * 1024 * 1024);
    const { pipe, wire } = await attach(s);
    const before = wire().length;

    await pipe.reflush({ bridge: new EventEmitter(), cols: COLS, rows: ROWS, generate: generateSnapshotUnqueued });
    await waitFor(() => wire().subarray(before).includes(MARKERS.flushDone), 30_000);
    const replay = between(wire().subarray(before), MARKERS.resyncBegin, MARKERS.flushDone);

    expect(await modesAfter(replay)).toEqual(CODEX_MODES);
    expect(count(replay, ALT_ON)).toBe(1);
  }, 60_000);

  it('does not double the alt-screen switch while the ring still carries it', async () => {
    const s = codexSession(ATTACH_SNAPSHOT_MIN_BYTES * 2);
    expect(s.ring.readAll().includes(ALT_ON)).toBe(true);

    const { wire } = await attach(s);
    const replay = between(wire(), null, MARKERS.flushDone);

    expect(await modesAfter(replay)).toEqual(CODEX_MODES);
    expect(count(replay, ALT_ON)).toBe(1);
  }, 30_000);

  it('does not apply a later ?7l to earlier output still in the ring (#1853)', async () => {
    const s = session();
    // A line wider than the pane wraps; the program turns autowrap off after it.
    s.write(`${'w'.repeat(COLS + 20)}\r\nafter\r\n\x1b[?7l`);
    const ringBytes = s.ring.readAll();

    const { wire } = await attach(s);
    const replay = between(wire(), null, MARKERS.flushDone);

    expect(replay.equals(ringBytes)).toBe(true);
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => term.write(replay, resolve));
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe('w'.repeat(20));
    } finally {
      term.dispose();
    }
  });

  it('leaves a plain shell pane byte-identical, with no modes added', async () => {
    const s = session();
    for (let i = 0; s.ring.totalBytesWritten < 9 * 1024 * 1024; i++) {
      s.write(`\x1b[3${i % 8}m$ make step ${i} ${'x'.repeat(60)}\x1b[0m\r\n`);
    }
    expect(s.tracker.preamble(0)).toBe('');

    const [withModes, without] = await Promise.all([attach(s), attach(s, false)]);
    const replay = between(withModes.wire(), null, MARKERS.flushDone);

    expect(replay.equals(between(without.wire(), null, MARKERS.flushDone))).toBe(true);
    expect(await modesAfter(replay)).toEqual({ buffer: 'normal', mouse: 'none', paste: false, focus: false });
  }, 60_000);
});
