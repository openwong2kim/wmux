/**
 * SSE keep-alive ping.
 *
 * An LTE carrier NAT drops a connection it has seen no packets on, and an idle
 * pane can go many minutes without output — so a phone that "was still
 * connected" is actually holding a dead socket, and only finds out when the
 * user looks. A comment frame (a line starting with `:`) is the SSE-native way
 * to push a byte without inventing an event the client has to know about:
 * EventSource ignores it entirely.
 *
 * Extracted from `WebTerminalServer` because both long-lived streams
 * (`/api/stream` and `/api/events`) need the identical timer, teardown, and
 * error swallowing, and a heartbeat that leaks a timer or holds the event loop
 * open is a daemon-shutdown bug rather than a browser one.
 */

/**
 * Ping cadence. Under the 30 s that mobile NATs and reverse proxies commonly
 * use as an idle timeout, with enough margin for a late timer on a busy daemon.
 */
export const SSE_HEARTBEAT_MS = 25_000;

/** The one thing a heartbeat needs from an `http.ServerResponse`. */
export interface SseWritable {
  write(chunk: string): unknown;
}

/**
 * Start pinging `res` every `intervalMs`. Returns the stop function; calling it
 * more than once is safe, so a caller can put it in a `detach()` that runs on
 * both an explicit teardown and the socket's own `close`.
 *
 * A failed write is swallowed: a broken stream is discovered and cleaned up by
 * the request's `close` handler, and throwing out of a timer callback would
 * take down the daemon's event loop instead.
 */
export function startSseHeartbeat(res: SseWritable, intervalMs: number = SSE_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* stream already broken — the 'close' handler cleans up */
    }
  }, intervalMs);
  // Never let a keep-alive be the reason the daemon cannot exit.
  timer.unref();

  let stopped = false;
  return (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
