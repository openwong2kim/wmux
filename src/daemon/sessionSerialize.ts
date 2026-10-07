import { generateSnapshot } from './HeadlessSnapshot';
import type { RingBuffer } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';
import { readRingWithModesAndGeometry } from './sessionTextReplay';

const MAX_RPC_PAYLOAD_BYTES = 512 * 1024; // base64 ×1.37 + JSON stays < 1 MB

export type SerializeSessionResult =
  | { ok: true; mode: 'unavailable'; reason: string }
  | { ok: true; mode: 'snapshot'; payloadBase64: string; cols: number; rows: number };

/**
 * The `daemon.serializeSession` answer for one session. The replay is led by
 * the session's mode preamble (#1853): once an alt-screen entry has aged out
 * of the ring, parsing the ring alone would serialize an alt-screen frame as
 * normal-buffer rows. With the entry restored the frame is serialized on the
 * alternate screen, and each stretch is parsed at the size it was written at.
 */
export async function serializeSession(
  session: {
    ringBuffer: Pick<RingBuffer, 'readAllWithGeometry'>;
    outputModes: Pick<OutputModeTracker, 'preamble'> | null;
    cols: number;
    rows: number;
  },
  requestedScrollback: number | undefined,
  log: (line: string) => void,
): Promise<SerializeSessionResult> {
  const scrollback = Math.min(typeof requestedScrollback === 'number' ? requestedScrollback : 2000, 10_000);
  const { replay: initial, geometry } = readRingWithModesAndGeometry(session.ringBuffer, session.outputModes);
  const base = { cols: session.cols, rows: session.rows, initial, geometry };
  let outcome = await generateSnapshot({ ...base, scrollback });
  if (outcome.ok && outcome.payload.length > MAX_RPC_PAYLOAD_BYTES) {
    outcome = await generateSnapshot({ ...base, scrollback: 0 });
  }
  if (!outcome.ok) {
    log(`unavailable reason=${outcome.reason}`);
    return { ok: true, mode: 'unavailable', reason: outcome.reason };
  }
  if (outcome.payload.length > MAX_RPC_PAYLOAD_BYTES) {
    log(`unavailable reason=too-large bytes=${outcome.payload.length}`);
    return { ok: true, mode: 'unavailable', reason: 'too-large' };
  }
  log(`mode=snapshot payload=${outcome.payload.length}`);
  return {
    ok: true,
    mode: 'snapshot',
    payloadBase64: outcome.payload.toString('base64'),
    cols: session.cols,
    rows: session.rows,
  };
}
