/**
 * In-band stream markers for the per-session data pipe protocol.
 *
 * These live in their own dependency-free module so the Electron main bundle
 * can import them (via sessionPipeStreamScanner) WITHOUT pulling in SessionPipe
 * and its transitive `@xterm/headless` dependency — the Vite main build cannot
 * resolve that package's exports, which broke `Package app` when TASK-10 added
 * the HeadlessSnapshot import to SessionPipe. Keep this file import-free.
 */

export interface SessionPipeMarkers {
  /** Sent after a Ring Buffer flush to signal transition to real-time mode. */
  flushDone: Buffer;
  /** Sent immediately before a live-pipe re-flush begins. */
  resyncBegin: Buffer;
}

/**
 * Build markers that only the authenticated daemon and main process can
 * predict. PTY output shares this byte stream, so a fixed public marker would
 * let stored output impersonate a flush boundary and regain live side-effect
 * authority during replay. The daemon auth token is never exposed to a remote
 * PTY producer; including it makes accidental or crafted collisions
 * negligible while keeping this module import-free for the Vite main build.
 * The resync marker is written on the already-flushed stream immediately
 * before live output is suppressed; everything until flushDone is replay.
 */
export function createSessionPipeMarkers(authToken: string): SessionPipeMarkers {
  return {
    flushDone: Buffer.from(`\x00WMUX_FLUSH_DONE:${authToken}\x00`),
    resyncBegin: Buffer.from(`\x00WMUX_RESYNC_BEGIN:${authToken}\x00`),
  };
}
