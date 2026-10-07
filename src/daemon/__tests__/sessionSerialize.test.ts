// #1853 — daemon.serializeSession must not serialize an alt-screen frame as
// normal-buffer rows once the alt-screen entry has aged out of the ring.
import { describe, it, expect } from 'vitest';
import { serializeSession } from '../sessionSerialize';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';

const COLS = 80;
const ROWS = 24;

function pane(write: (put: (text: string) => void) => void) {
  const ringBuffer = new RingBuffer(256 * 1024);
  const tracker = new OutputModeTracker();
  write((text) => {
    ringBuffer.write(Buffer.from(text, 'utf8'));
    tracker.feed(text, ringBuffer.totalBytesWritten);
  });
  return { ringBuffer, tracker };
}

/** A fullscreen app entered the alt screen, then painted 512 KB of frames. */
function wrappedTui() {
  return pane((put) => {
    put('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    for (let i = 0, n = 0; n < 512 * 1024; i++) {
      let f = '\x1b[H';
      for (let r = 1; r <= ROWS; r++) f += `\x1b[${r};1Hframe ${i} row ${r}`;
      put(f);
      n += f.length;
    }
  });
}

const noLog = (): void => undefined;

describe('serializeSession (#1853)', () => {
  it('declines an alt-screen pane whose entry has aged out of the ring', async () => {
    const { ringBuffer, tracker } = wrappedTui();
    expect(ringBuffer.readAll().includes('\x1b[?1049h')).toBe(false);

    const result = await serializeSession({ ringBuffer, outputModes: tracker, cols: COLS, rows: ROWS }, undefined, noLog);

    expect(result).toEqual({ ok: true, mode: 'unavailable', reason: 'alt-screen' });
  });

  it('★ without the mode tracker the same ring serializes as a normal-buffer snapshot', async () => {
    // The pre-fix behavior: the snapshot "succeeds" with the frame parsed in
    // the wrong buffer. Pins that the tracker is what makes the difference.
    const { ringBuffer } = wrappedTui();
    const result = await serializeSession({ ringBuffer, outputModes: null, cols: COLS, rows: ROWS }, undefined, noLog);
    expect(result.mode).toBe('snapshot');
  });

  it('still serializes a plain shell pane', async () => {
    const { ringBuffer, tracker } = pane((put) => {
      for (let i = 0; i < 4000; i++) put(`$ step ${i} ${'x'.repeat(60)}\r\n`);
    });
    const result = await serializeSession({ ringBuffer, outputModes: tracker, cols: COLS, rows: ROWS }, 100, noLog);
    expect(result.mode).toBe('snapshot');
  });
});
