/**
 * In-band stream markers for the per-session data pipe protocol.
 *
 * These live in their own module so the Electron main bundle can import them
 * (via sessionPipeStreamScanner) WITHOUT pulling in SessionPipe and its
 * transitive `@xterm/headless` dependency — the Vite main build cannot
 * resolve that package's exports, which broke `Package app` when TASK-10 added
 * the HeadlessSnapshot import to SessionPipe. Keep this file free of package
 * imports; Node builtins such as `node:crypto` are fine (the main bundle
 * already uses them).
 */
import { createHmac } from 'node:crypto';

export interface SessionPipeMarkers {
  /** Sent after a Ring Buffer flush to signal transition to real-time mode. */
  flushDone: Buffer;
  /** Sent immediately before a live-pipe re-flush begins. */
  resyncBegin: Buffer;
  /**
   * The earlier marker form, which carried the token itself. The daemon never
   * sends it; main's scanner still accepts it so a daemon from an older
   * release that is kept running (a failed or skipped replacement) can finish
   * its replays. Removable once no supported daemon sends the old form.
   */
  legacy: { flushDone: Buffer; resyncBegin: Buffer };
}

/** Hex characters of the HMAC kept in each marker (128 bits). */
const MARKER_TAG_HEX_CHARS = 32;

function markerTag(authToken: string, label: string): string {
  return createHmac('sha256', authToken).update(label).digest('hex').slice(0, MARKER_TAG_HEX_CHARS);
}

/**
 * Build markers that only the authenticated daemon and main process can
 * predict. PTY output shares this byte stream, so a fixed public marker would
 * let stored output impersonate a flush boundary and regain live side-effect
 * authority during replay. Each marker carries an HMAC-SHA256 of a fixed
 * per-marker label keyed by the daemon auth token, so the stream markers no
 * longer carry the daemon's token while staying unpredictable without it.
 * The resync marker is written on the already-flushed stream immediately
 * before live output is suppressed; everything until flushDone is replay.
 */
export function createSessionPipeMarkers(authToken: string): SessionPipeMarkers {
  return {
    flushDone: Buffer.from(`\x00WMUX_FLUSH_DONE:${markerTag(authToken, 'wmux-session-pipe/flush-done')}\x00`),
    resyncBegin: Buffer.from(`\x00WMUX_RESYNC_BEGIN:${markerTag(authToken, 'wmux-session-pipe/resync-begin')}\x00`),
    legacy: {
      flushDone: Buffer.from(`\x00WMUX_FLUSH_DONE:${authToken}\x00`),
      resyncBegin: Buffer.from(`\x00WMUX_RESYNC_BEGIN:${authToken}\x00`),
    },
  };
}
