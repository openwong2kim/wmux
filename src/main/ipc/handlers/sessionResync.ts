/**
 * One live-pipe re-flush per session at a time, shared by every main-side
 * caller (pty:resync for a pane reveal, pty:reconnect for a Terminal adopting
 * a pane main created).
 *
 * The protocol has state in two places: main's stream scanner is armed to
 * catch the in-band RESYNC_BEGIN, and the daemon's SessionPipe holds the pipe
 * for the whole re-flush (`RESYNC_BUSY` while queued, `flushed=false` from
 * RESYNC_BEGIN to FLUSH_DONE). Two callers each arming, calling and disarming
 * on their own interleave badly: one caller's failure disarms the watch the
 * other's re-flush depends on (its markers and replay then reach the terminal
 * as live output), and a re-flush in progress reads to the second caller as
 * "no flushed client". Main is the only caller of daemon.resyncSession, so
 * joining the episode in flight here keeps every re-flush single-owner, and
 * every caller gets that episode's real outcome.
 *
 * Electron-free so it can be unit tested.
 */
import type { DaemonClient } from '../../DaemonClient';
import { DAEMON_RESYNC_RPC_TIMEOUT_MS } from '../../../shared/timeouts';

export type SessionResyncClient = Pick<DaemonClient, 'rpc' | 'isSessionPipeWritable' | 'armSessionResync' | 'disarmSessionResync'>;

export type SessionResyncResult =
  | { success: true; mode: 'snapshot' | 'raw' }
  | { success: false; code: 'pipe-not-writable' | 'rpc-error'; reason?: string; transient: true }
  | { success: false; code: 'legacy-daemon'; transient: false };

export interface SessionResync {
  /** Re-flush `id` over its live pipe, or join the re-flush already running. */
  (id: string, scrollback?: number): Promise<SessionResyncResult>;
  /** Whether a re-flush of `id` is in flight. */
  inFlight(id: string): boolean;
  /**
   * main's scanner reported a flush complete for `id`. The episode's replay
   * and its flushComplete have gone out, so it takes no more joiners: one
   * arriving now would wait for a flushComplete already sent. Its own callers
   * still get its outcome when the daemon's reply lands (the FLUSH_DONE on
   * the session socket can be read before the reply on the control socket).
   */
  flushCompleted(id: string): void;
}

export function createSessionResync(client: SessionResyncClient): SessionResync {
  const episodes = new Map<string, Promise<SessionResyncResult>>();

  const run = async (id: string, scrollback: number | undefined): Promise<SessionResyncResult> => {
    // The re-flush rides the existing connected socket.
    if (!client.isSessionPipeWritable(id)) {
      // Pipe not (yet) writable — the socket may be mid-replacement. Retry.
      return { success: false, code: 'pipe-not-writable', transient: true };
    }
    if (!client.armSessionResync(id)) {
      // No live scanner (pipe absent or still doing its initial flush). Retry.
      return { success: false, code: 'pipe-not-writable', transient: true };
    }
    try {
      // Extended timeout (Codex round-2 P2): the reflush legitimately waits
      // behind the global snapshot slot under concurrent reveals — the
      // default 10s RPC ceiling would disarm the scanner and tear the
      // socket via reconnect while the daemon still writes the in-band
      // replay. Must stay below the renderer's 32s resync-abort ceiling.
      const res = await client.rpc('daemon.resyncSession', { id, scrollback }, { timeoutMs: DAEMON_RESYNC_RPC_TIMEOUT_MS }) as {
        mode: 'snapshot' | 'raw';
      };
      // The scanner disarms itself when it consumes the in-band RESYNC_BEGIN
      // the daemon just wrote, so no disarm is needed on the success path.
      return { success: true, mode: res.mode };
    } catch (err) {
      // RPC failed AFTER arming — the scanner is still watching for a BEGIN
      // marker that will now never come. Disarm so it doesn't misclassify a
      // future coincidental byte run (harmless but must not linger). This
      // episode owns the watch: no other re-flush of this session can be
      // running beside it.
      client.disarmSessionResync(id);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unknown method')) {
        // Pre-PR-B daemon: no daemon.resyncSession. Renderer degrades to the
        // classic pty:reconnect. Permanent for THIS daemon build.
        return { success: false, code: 'legacy-daemon', transient: false };
      }
      return { success: false, code: 'rpc-error', reason: msg, transient: true };
    }
  };

  const resync = ((id: string, scrollback?: number) => {
    const running = episodes.get(id);
    if (running) return running;
    const episode = run(id, scrollback).finally(() => {
      if (episodes.get(id) === episode) episodes.delete(id);
    });
    episodes.set(id, episode);
    return episode;
  }) as SessionResync;
  resync.inFlight = (id: string) => episodes.has(id);
  // Only a re-flush can be in flight when this fires for a session with an
  // episode: arming needs a live scanner, so no attach flush runs beside it.
  resync.flushCompleted = (id: string) => {
    episodes.delete(id);
  };
  return resync;
}
