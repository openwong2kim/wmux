import type { RingBuffer } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';

/** Restore terminal modes whose entry sequences have fallen out of the ring. */
export function readSessionTextReplay(
  ring: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): Buffer {
  // Capture the bytes and their absolute offset without yielding, so the mode
  // tracker and replay describe the same point in the output stream.
  const initial = ring.readAll();
  const startOffset = ring.totalBytesWritten - initial.length;
  const preamble = outputModes?.preamble(startOffset) ?? '';
  return preamble ? Buffer.concat([Buffer.from(preamble, 'utf8'), initial]) : initial;
}
