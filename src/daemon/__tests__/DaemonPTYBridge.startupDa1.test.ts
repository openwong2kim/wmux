// #1965 — the daemon answers the bundled OpenConsole's startup DA1, once, and
// only under a narrow gate. OpenConsole writes `CSI c` before anything else and
// holds the shell's output until a terminal answers (about 3 s otherwise); a
// fresh pane's query lands in the ring before any renderer receives live bytes,
// and every replay strips queries, so nobody else ever answers it.
import { describe, it, expect, afterEach } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge, STARTUP_DA1_REPLY, scanStartupDa1 } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

// What the bundled OpenConsole 1.23 writes first (measured with node-pty 1.1.0).
const OPENCONSOLE_PREAMBLE = '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h';

interface Harness {
  bridge: DaemonPTYBridge;
  feed: (data: string) => void;
  writes: string[];
  answered: number;
  inputEvents: string[];
  ring: RingBuffer;
}

function makeHarness(canAnswer: () => boolean = () => true, opts: { muted?: boolean } = {}): Harness {
  let dataHandler: ((data: string) => void) | null = null;
  const writes: string[] = [];
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
    write: (data: string) => { writes.push(data); },
  } as unknown as IPty;
  const bridge = new DaemonPTYBridge();
  const ring = new RingBuffer(65536);
  const h: Harness = { bridge, feed: (d) => dataHandler?.(d), writes, answered: 0, inputEvents: [], ring };
  for (const ev of ['typedInput', 'fenceInput', 'inputSubmitted', 'answered', 'awaitingActivity']) {
    bridge.on(ev, () => h.inputEvents.push(ev));
  }
  if (opts.muted) bridge.setMuted(true);
  bridge.armStartupDa1Reply(canAnswer, () => { h.answered += 1; });
  bridge.setupDataForwarding(pty, ring, 'sess-da1');
  return h;
}

describe('scanStartupDa1', () => {
  it.each([
    ['the bare query', '\x1b[c', 'answer'],
    ['OpenConsole preamble', OPENCONSOLE_PREAMBLE, 'answer'],
    ['only other CSI so far', '\x1b[1t\x1b[?1004h', 'more'],
    ['a sequence cut after ESC', '\x1b[1t\x1b', 'more'],
    ['a sequence cut after CSI', '\x1b[1t\x1b[', 'more'],
    ['a parameterised DA1 is not the bare query', '\x1b[0c', 'more'],
    ['text first', 'Microsoft Windows\x1b[c', 'closed'],
    ['a CR first', '\r\n\x1b[c', 'closed'],
    ['an OSC first', '\x1b]0;title\x07\x1b[c', 'closed'],
    ['DA2 is not DA1', '\x1b[>c', 'more'],
  ])('%s', (_label, input, expected) => {
    expect(scanStartupDa1(input)).toBe(expected);
  });
});

describe('DaemonPTYBridge — startup DA1 reply (#1965)', () => {
  const harnesses: Harness[] = [];
  const fresh = (...args: Parameters<typeof makeHarness>): Harness => {
    const h = makeHarness(...args);
    harnesses.push(h);
    return h;
  };

  afterEach(() => {
    for (const h of harnesses.splice(0)) h.bridge.cleanup();
  });

  it('answers the startup query exactly once, with xterm\'s DA1', () => {
    const h = fresh();
    h.feed(OPENCONSOLE_PREAMBLE);
    // A second query (a program's own, later) is not the startup one.
    h.feed('\x1b[c');
    expect(h.writes).toEqual([STARTUP_DA1_REPLY]);
    expect(STARTUP_DA1_REPLY).toBe('\x1b[?62;4;9;22c');
    expect(h.answered).toBe(1);
  });

  it('answers a query split across chunks', () => {
    const h = fresh();
    h.feed('\x1b[1t\x1b');
    expect(h.writes).toEqual([]);
    h.feed('[c\x1b[?1004h');
    expect(h.writes).toEqual([STARTUP_DA1_REPLY]);
  });

  it('does not answer when a renderer receives the chunk live', () => {
    const h = fresh(() => false);
    h.feed(OPENCONSOLE_PREAMBLE);
    expect(h.writes).toEqual([]);
    // The decision is made once: a later query is never answered either.
    h.feed('\x1b[c');
    expect(h.writes).toEqual([]);
  });

  it('does not answer a query that follows other output', () => {
    const h = fresh();
    h.feed('Microsoft Windows [Version 10.0.19045]\r\n');
    h.feed('\x1b[c');
    expect(h.writes).toEqual([]);
  });

  it('gives up after a long escape-only prefix', () => {
    const h = fresh();
    h.feed('\x1b[?1004h'.repeat(10));
    h.feed('\x1b[c');
    expect(h.writes).toEqual([]);
  });

  it('answers while output is muted (a recovered session), and the query is still held', () => {
    const h = fresh(() => true, { muted: true });
    h.feed(OPENCONSOLE_PREAMBLE);
    expect(h.writes).toEqual([STARTUP_DA1_REPLY]);
    expect(h.ring.readAll().toString()).toBe('');
    // The replay strips it, so no renderer answers it a second time.
    h.bridge.setMuted(false, { replayHeld: true });
    expect(h.ring.readAll().toString()).toBe('\x1b[1t\x1b[?1004h\x1b[?9001h');
  });

  it('does not count the reply as user input', () => {
    const h = fresh();
    const revision = h.bridge.getInputRevision();
    h.feed(OPENCONSOLE_PREAMBLE);
    expect(h.writes).toEqual([STARTUP_DA1_REPLY]);
    // No draft, no input stamp, no input-driven event (#1882 class).
    expect(h.bridge.getInputRevision()).toBe(revision);
    expect(h.bridge.isInputQuiet()).toBe(true);
    expect(h.inputEvents).toEqual([]);
  });
});
