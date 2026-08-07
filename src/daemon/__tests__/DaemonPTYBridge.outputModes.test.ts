// The tracker/ring wiring, exercised through the REAL setupDataForwarding
// path rather than by handing WebTerminalServer a hand-built tracker.
//
// The preamble is only correct while the tracker's state describes exactly the
// bytes the ring holds — and the two are filled in two different places (a
// recovered session's scrollback goes straight into the ring, before any bridge
// exists), so a divergence here is invisible to every test that stubs
// `bridge.outputModes`.
import { describe, it, expect, afterEach } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => { /* noop */ } }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

const ALT_PREAMBLE = '\x1b[?1049h\x1b[2J\x1b[H';

/** What WebTerminalServer computes: the absolute offset of the window's first byte. */
function windowStart(ring: RingBuffer, windowBytes: number): number {
  return ring.totalBytesWritten - Math.min(windowBytes, ring.size);
}

describe('DaemonPTYBridge output-mode tracking', () => {
  let bridge: DaemonPTYBridge | null = null;

  afterEach(() => {
    bridge?.cleanup();
    bridge = null;
  });

  it('tracks modes off live PTY output', () => {
    const ring = new RingBuffer(65536);
    const fake = makeFakePty();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(fake.pty, ring, 'sess-live');

    expect(bridge.outputModes?.altScreen).toBe(false);
    fake.feed('\x1b[?1049h\x1b[2J');
    expect(bridge.outputModes?.altScreen).toBe(true);
  });

  it('★ sees the scrollback a RECOVERED session pre-filled into the ring', () => {
    // DaemonSessionManager writes the saved buffer dump into the ring BEFORE
    // constructing the bridge. A tracker that only watched live output would
    // report "normal buffer" for a pane that has been inside a fullscreen app
    // since before the daemon restarted — no preamble, and the garbling this
    // whole mechanism exists to prevent comes straight back.
    const ring = new RingBuffer(65536);
    ring.write(Buffer.from('\x1b[?1049h\x1b[2J\x1b[Hrestored frame\r\n', 'utf8'));
    const fake = makeFakePty();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(fake.pty, ring, 'sess-recovered');

    expect(bridge.outputModes?.altScreen).toBe(true);
  });

  it('★ keeps ring and tracker offsets in one coordinate system across a prefill', () => {
    const ring = new RingBuffer(65536);
    // Restored scrollback: the alt entry is at the very front of it.
    ring.write(Buffer.from('\x1b[?1049h\x1b[2J\x1b[H', 'utf8'));
    const fake = makeFakePty();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(fake.pty, ring, 'sess-offsets');
    // …then the app keeps painting, pushing the entry back.
    fake.feed('frame\r\n'.repeat(200));

    const modes = bridge.outputModes;
    expect(modes).not.toBeNull();
    // A window big enough to reach the restored entry must NOT re-assert it.
    expect(modes?.preamble(windowStart(ring, ring.size))).toBe('');
    // A window that only covers the live frames must.
    expect(modes?.preamble(windowStart(ring, 64))).toBe(ALT_PREAMBLE);
  });

  it('drops the tracker on cleanup', () => {
    const ring = new RingBuffer(4096);
    const fake = makeFakePty();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(fake.pty, ring, 'sess-cleanup');
    expect(bridge.outputModes).not.toBeNull();
    bridge.cleanup();
    expect(bridge.outputModes).toBeNull();
  });
});
