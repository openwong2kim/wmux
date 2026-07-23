/**
 * In-band stream markers for the per-session data pipe protocol.
 *
 * These live in their own dependency-free module so the Electron main bundle
 * can import them (via sessionPipeStreamScanner) WITHOUT pulling in SessionPipe
 * and its transitive `@xterm/headless` dependency — the Vite main build cannot
 * resolve that package's exports, which broke `Package app` when TASK-10 added
 * the HeadlessSnapshot import to SessionPipe. Keep this file import-free.
 */

/** Marker sent after Ring Buffer flush to signal transition to real-time mode. */
export const FLUSH_DONE_MARKER = Buffer.from('\x00WMUX_FLUSH_DONE\x00');

/**
 * In-band announcement that a live-pipe re-flush is starting (phase 3 PR-B).
 * Written on the ALREADY-FLUSHED stream right before live output is
 * suppressed; everything after it up to the next FLUSH_DONE_MARKER is replay
 * (snapshot or raw) that the client must accumulate exactly like the initial
 * flush. Carrying the state transition in the stream itself is what makes the
 * protocol race-free: no RPC-vs-stream ordering can misclassify bytes.
 */
export const RESYNC_BEGIN_MARKER = Buffer.from('\x00WMUX_RESYNC_BEGIN\x00');
