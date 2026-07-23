import { FLUSH_DONE_MARKER, RESYNC_BEGIN_MARKER } from '../../daemon/sessionPipeMarkers';

/**
 * Stream events produced while scanning a session pipe's byte stream.
 *
 * `data`          — raw PTY bytes to forward to the renderer, in order.
 * `flushComplete` — the ring-buffer flush (or a live re-flush) finished;
 *                   `recoveredBytes` is the PRE-STRIP length of the replayed
 *                   scrollback that preceded the FLUSH_DONE_MARKER (0 means the
 *                   daemon had no authoritative scrollback — see the note in
 *                   the flush-detection block below).
 */
export type ScanEvent =
  | { type: 'data'; data: Buffer }
  | { type: 'flushComplete'; recoveredBytes: number };

const DEFAULT_MAX_PENDING_BYTES = 10 * 1024 * 1024; // 10 MB safety cap
const EMPTY = Buffer.alloc(0);

/**
 * Pure state machine for a single session pipe's inbound byte stream (phase 3
 * PR-B). Extracted verbatim from DaemonClient.setupSessionPipe so the exact
 * byte accounting is testable in isolation, then extended with the live
 * re-flush protocol.
 *
 * Two modes:
 *   - accumulating — buffer bytes until FLUSH_DONE_MARKER, then emit the
 *     pre-marker replay (query-sanitized), a flushComplete, and any post-marker
 *     live tail. This is the initial ring-buffer flush, and — after a
 *     RESYNC_BEGIN — the re-flush.
 *   - live — steady state. When NOT armed, chunks pass straight through with
 *     zero scanning or copying (the common case; overhead must stay at 0). When
 *     armed for a resync, the stream is scanned for RESYNC_BEGIN_MARKER, which
 *     the daemon writes in-band right before it re-runs the flush sequence on
 *     the same socket. Carrying the transition in the stream is what makes the
 *     protocol race-free (no RPC-vs-stream ordering can misclassify bytes).
 */
export class SessionPipeStreamScanner {
  private _mode: 'accumulating' | 'live' = 'accumulating';
  private armed = false;
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  // live + armed only: the longest stream tail that is a strict prefix of
  // RESYNC_BEGIN_MARKER, held back until the next chunk can confirm or deny it.
  private carry: Buffer = EMPTY;
  private readonly maxPendingBytes: number;
  private readonly stripReplay: (b: Buffer) => Buffer;

  constructor(opts: { maxPendingBytes?: number; stripReplay: (b: Buffer) => Buffer }) {
    this.maxPendingBytes = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.stripReplay = opts.stripReplay;
  }

  get mode(): 'accumulating' | 'live' {
    return this._mode;
  }

  /** Start watching a live stream for the in-band RESYNC_BEGIN_MARKER. */
  armResync(): void {
    this.armed = true;
  }

  /**
   * Stop watching for RESYNC_BEGIN. Any bytes held back as a possible marker
   * prefix are real live output the daemon never followed with a marker, so
   * they are released as a final `data` event. Returns events (not void) so the
   * carry release is routed through the same ordered emit path as feed().
   */
  disarmResync(): ScanEvent[] {
    this.armed = false;
    if (this.carry.length > 0) {
      const held = this.carry;
      this.carry = EMPTY;
      return [{ type: 'data', data: held }];
    }
    return [];
  }

  /** Feed one inbound chunk; returns the resulting events in stream order. */
  feed(chunk: Buffer): ScanEvent[] {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    if (this._mode === 'accumulating') {
      return this.accumulate(buf);
    }

    if (!this.armed) {
      // Steady state — no scan, no copy. Identical to the original live path.
      return buf.length > 0 ? [{ type: 'data', data: buf }] : [];
    }

    return this.scanArmed(buf);
  }

  /**
   * Buffer until FLUSH_DONE_MARKER, then emit replay → flushComplete → live
   * tail. Byte-for-byte identical to the original setupSessionPipe closure;
   * also reused for the post-RESYNC re-flush.
   */
  private accumulate(buf: Buffer): ScanEvent[] {
    this.pendingChunks.push(buf);
    this.pendingBytes += buf.length;

    // Prevent unbounded accumulation if the flush marker never arrives. Matches
    // the original: drop everything buffered, flip to live, emit nothing.
    if (this.pendingBytes > this.maxPendingBytes) {
      this._mode = 'live';
      this.armed = false;
      this.pendingChunks = [];
      this.pendingBytes = 0;
      return [];
    }

    const combined = Buffer.concat(this.pendingChunks);
    const markerIndex = combined.indexOf(FLUSH_DONE_MARKER);
    if (markerIndex === -1) return [];

    this._mode = 'live';
    this.pendingChunks = [];
    this.pendingBytes = 0;

    const events: ScanEvent[] = [];

    // markerIndex is exactly the count of replayed scrollback bytes: 0 when the
    // daemon's ringBuffer was empty (mismatch case — recovery cap dropped this
    // session, or it was created fresh by reconcile fallback). The renderer
    // uses this to decide whether to wipe its .txt cache.
    // NOTE: pre-strip length on purpose — recoveredBytes answers "did the daemon
    // have authoritative scrollback", which the renderer's reset-or-keep
    // decision depends on, not the sanitized byte count.
    const recoveredBytes = markerIndex;

    // Emit data before marker (ring buffer replay). Queries stored in the ring
    // (DSR/CPR, DA, DECRQM, ...) are stripped first: xterm.js re-executes
    // replayed bytes, so a stored query would fire a live auto-reply into the
    // fresh shell's stdin — the CPR feedback storm of 2026-07-04 (see
    // shared/replayQuerySanitizer.ts). Live bytes after the marker are never
    // sanitized.
    if (markerIndex > 0) {
      const replay = this.stripReplay(combined.subarray(0, markerIndex));
      if (replay.length > 0) {
        events.push({ type: 'data', data: replay });
      }
    }

    // Fire flush-complete BEFORE the post-marker data so the renderer's
    // reset-or-keep decision lands before any live PTY bytes start composing on
    // the buffer.
    events.push({ type: 'flushComplete', recoveredBytes });

    // Emit data after marker (if any real-time data arrived in the same chunk).
    // After both the initial flush and a re-flush the scanner is disarmed, so
    // this tail is plain live output — passed straight through like the original.
    const afterMarker = combined.subarray(markerIndex + FLUSH_DONE_MARKER.length);
    if (afterMarker.length > 0) {
      events.push({ type: 'data', data: afterMarker });
    }

    return events;
  }

  /**
   * live + armed: scan for RESYNC_BEGIN_MARKER across chunk boundaries. On a
   * hit, flush the pre-marker bytes, drop the marker, disarm, and hand the
   * post-marker residual to the accumulator (the re-flush replay). On a miss,
   * hold back only the tail that could still complete into the marker and emit
   * the rest immediately (echo latency must not regress).
   */
  private scanArmed(buf: Buffer): ScanEvent[] {
    const combined = this.carry.length > 0 ? Buffer.concat([this.carry, buf]) : buf;
    this.carry = EMPTY;

    const markerIndex = combined.indexOf(RESYNC_BEGIN_MARKER);
    if (markerIndex !== -1) {
      const events: ScanEvent[] = [];
      if (markerIndex > 0) {
        events.push({ type: 'data', data: combined.subarray(0, markerIndex) });
      }
      // Consume the marker and re-enter accumulation for the re-flush. Auto
      // disarm: the resync episode is now owned by the FLUSH_DONE cycle.
      this.armed = false;
      this._mode = 'accumulating';
      const residual = combined.subarray(markerIndex + RESYNC_BEGIN_MARKER.length);
      if (residual.length > 0) {
        events.push(...this.accumulate(residual));
      }
      return events;
    }

    // No full marker in this buffer. Only a tail that is a strict prefix of the
    // marker can still complete on the next chunk; everything before it is
    // definitely live data.
    const hold = this.matchingPrefixLen(combined);
    if (hold === 0) {
      return combined.length > 0 ? [{ type: 'data', data: combined }] : [];
    }
    const emittable = combined.subarray(0, combined.length - hold);
    this.carry = combined.subarray(combined.length - hold);
    return emittable.length > 0 ? [{ type: 'data', data: emittable }] : [];
  }

  /**
   * Length of the longest suffix of `buf` that equals a prefix of
   * RESYNC_BEGIN_MARKER (in [0, marker.length - 1]). Called only when the full
   * marker is absent, so a match can exist only at the tail.
   */
  private matchingPrefixLen(buf: Buffer): number {
    const marker = RESYNC_BEGIN_MARKER;
    const maxK = Math.min(marker.length - 1, buf.length);
    for (let k = maxK; k >= 1; k--) {
      if (buf.subarray(buf.length - k).equals(marker.subarray(0, k))) {
        return k;
      }
    }
    return 0;
  }
}
