import type { RingBuffer } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';

/**
 * The ring's bytes (`raw`) and the same bytes led by the mode preamble
 * (`replay`), which restores terminal modes whose entry sequences have fallen
 * out of the ring.
 */
export function readRingWithModes(
  ring: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): { raw: Buffer; replay: Buffer } {
  // Capture the bytes and their absolute offset without yielding, so the mode
  // tracker and replay describe the same point in the output stream.
  const raw = ring.readAll();
  const startOffset = ring.totalBytesWritten - raw.length;
  const preamble = outputModes?.preamble(startOffset) ?? '';
  return { raw, replay: preamble ? Buffer.concat([Buffer.from(preamble, 'utf8'), raw]) : raw };
}

/** Restore terminal modes whose entry sequences have fallen out of the ring. */
export function readSessionTextReplay(
  ring: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): Buffer {
  return readRingWithModes(ring, outputModes).replay;
}
