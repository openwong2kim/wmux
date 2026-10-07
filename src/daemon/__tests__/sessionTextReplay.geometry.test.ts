// #1825 on top of #1853: replays are led by the mode preamble, so the recorded
// size-change offsets must move past it to still point at the same ring bytes.
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { readRingWithModesAndGeometry } from '../sessionTextReplay';

describe('readRingWithModesAndGeometry', () => {
  it('shifts size-change offsets past the preamble', () => {
    const ring = new RingBuffer(1024);
    const tracker = new OutputModeTracker();
    const put = (text: string) => {
      ring.write(Buffer.from(text, 'utf8'));
      tracker.feed(text, ring.totalBytesWritten);
    };
    ring.noteGeometry(80, 24);
    put('\x1b[?1049h');
    put('x'.repeat(2000)); // the alt-screen entry ages out of the 1 KB ring
    ring.noteGeometry(40, 24);
    put('y'.repeat(100));

    const { raw, replay, geometry } = readRingWithModesAndGeometry(ring, tracker);
    const lead = replay.length - raw.length;
    expect(lead).toBeGreaterThan(0);
    expect(geometry?.start).toEqual({ cols: 80, rows: 24 });
    expect(geometry?.changes).toEqual([{ offset: raw.length - 100 + lead, cols: 40, rows: 24 }]);
    expect(replay.subarray(geometry!.changes[0].offset).toString()).toBe('y'.repeat(100));
  });
});
