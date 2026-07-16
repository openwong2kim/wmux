/**
 * DaemonDataBatcher — app-weight P1-3.
 *
 * Daemon-mode PTY data used to be forwarded to the renderer chunk-by-chunk
 * (SessionPipe → DaemonClient 'session:data' → webContents.send per chunk),
 * unlike local mode where PTYBridge micro-batches at 8 ms. Under agent
 * torrents that meant one IPC wakeup per pipe chunk. This class gives the
 * daemon path the same 8 ms coalescing, with the ordering rules the eng
 * review made mandatory (PR #470 plan, eng F3 / codex #14):
 *
 *   • flushSession() MUST run before forwarding any per-session ordering
 *     marker (PTY_FLUSH_COMPLETE / PTY_EXIT / PTY_RESTARTED) — a marker that
 *     overtakes buffered data makes the renderer settle a resync on a
 *     partial replay and parse the late chunk as live output.
 *   • Listener replacement flushes first, so ≤8 ms of old-generation bytes
 *     are delivered in today's (pre-batching) order instead of leaking into
 *     the new generation's stream.
 *   • Per-session buffered chars are bounded: a blocked renderer triggers an
 *     immediate synchronous flush instead of unbounded main-process growth.
 *
 * StringDecoder stays UPSTREAM of this class — push() takes decoded strings,
 * so multi-byte sequences can never split across a batch boundary.
 */
export class DaemonDataBatcher {
  private pending = new Map<string, string[]>();
  private pendingChars = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly send: (sessionId: string, text: string) => void,
    private readonly intervalMs = 8,
    /** Per-session cap; exceeding it flushes synchronously (bounded memory). */
    private readonly maxBufferedChars = 4 * 1024 * 1024,
  ) {}

  push(sessionId: string, text: string): void {
    if (!text) return;
    if (this.disposed) {
      // Late chunk after dispose (handler swap raced a pipe read): DROP it.
      // The daemon RingBuffer is the byte SSOT and the new generation's
      // reattach replays authoritative content, so nothing is lost end-to-end
      // — while delivering old-generation bytes here could land AFTER the new
      // generation's resync markers and parse as live output (exactly the
      // corruption the flush-before-marker rules exist to prevent; GLM
      // review, PR #471).
      return;
    }
    const buf = this.pending.get(sessionId);
    if (buf) {
      buf.push(text);
    } else {
      this.pending.set(sessionId, [text]);
    }
    const chars = (this.pendingChars.get(sessionId) ?? 0) + text.length;
    this.pendingChars.set(sessionId, chars);
    if (chars >= this.maxBufferedChars) {
      this.flushSession(sessionId);
      return;
    }
    if (!this.timers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.timers.delete(sessionId);
        this.flushSession(sessionId);
      }, this.intervalMs);
      this.timers.set(sessionId, timer);
    }
  }

  /** Deliver everything buffered for one session, in order, as one send. */
  flushSession(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    const buf = this.pending.get(sessionId);
    if (!buf || buf.length === 0) return;
    this.pending.delete(sessionId);
    this.pendingChars.delete(sessionId);
    this.send(sessionId, buf.join(''));
  }

  /** Drop a session's buffer without sending (session destroyed mid-batch). */
  drop(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    this.pending.delete(sessionId);
    this.pendingChars.delete(sessionId);
  }

  /** Flush every session (handler swap / shutdown) and stop accepting timers. */
  dispose(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.flushSession(sessionId);
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.disposed = true;
  }
}
