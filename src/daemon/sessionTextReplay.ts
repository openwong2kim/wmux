import type { RingBuffer, ReplayGeometry } from './RingBuffer';
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

/**
 * readRingWithModes plus the sizes the bytes were written at (#1825), with the
 * size-change offsets moved past the preamble so they still point at the same
 * ring bytes inside `replay`. The preamble only sets modes, so parsing it at
 * the start size is exact. `writtenAt` is the ring's lifetime byte count at
 * the read, which locates the bytes that arrive after it.
 */
export function readRingWithModesAndGeometry(
  ring: Pick<RingBuffer, 'readAllWithGeometry'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): { raw: Buffer; replay: Buffer; geometry: ReplayGeometry | undefined; writtenAt: number } {
  const { data: raw, geometry, writtenAt } = ring.readAllWithGeometry();
  const preamble = outputModes?.preamble(writtenAt - raw.length) ?? '';
  if (!preamble) return { raw, replay: raw, geometry, writtenAt };
  const lead = Buffer.from(preamble, 'utf8');
  return {
    raw,
    replay: Buffer.concat([lead, raw]),
    geometry: geometry && {
      start: geometry.start,
      changes: geometry.changes.map((c) => ({ ...c, offset: c.offset + lead.length })),
    },
    writtenAt,
  };
}
