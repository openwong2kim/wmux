/**
 * Bounded parse barrier for the MCP read path (pane.search / input.readScreen).
 *
 * Why this exists:
 *   Before reading a pane's xterm buffer we hand it an empty write and wait for
 *   the callback — xterm invokes it only after everything queued ahead of it has
 *   been parsed, so the reader sees a settled buffer instead of a half-applied
 *   frame.
 *
 *   That callback is not guaranteed to fire. xterm's WriteBuffer drains inside
 *   `_innerWrite`, and a handler that THROWS mid-dispatch takes the whole drain
 *   loop with it: `_bufferOffset` never advances, nothing reschedules, and every
 *   callback behind it — including the barrier's — is stranded for the lifetime
 *   of that Terminal. One real instance was the es2020-lowering miscompile of
 *   `@xterm/xterm`'s DECRQM handler (see the target note in
 *   vite.renderer.config.ts); a wedged pane made every terminal_read against it
 *   fail with `RPC timeout: input.readScreen (5000ms)` and no other signal.
 *
 *   A read is allowed to be slightly stale. It is NOT allowed to hang: the
 *   caller's RPC deadline is 5s and a timeout returns nothing at all, whereas a
 *   bounded wait still returns the pane's real (if fractionally older) content.
 *   So the barrier gives xterm a budget and then reads regardless.
 */

/** Budget for the barrier. Generous next to an ordinary parse (xterm drains in
 *  12ms slices and a settled pane calls back on the next tick) and comfortably
 *  inside the 5s RPC deadline, so a busy-but-healthy pane still settles fully
 *  while a wedged one costs the reader a fraction of its budget. */
export const PARSE_BARRIER_TIMEOUT_MS = 1_000;

/** The subset of xterm's Terminal this barrier needs. */
export interface BarrierWritable {
  write(data: string, callback?: () => void): void;
}

/**
 * Resolve once xterm reports the pane parsed, or once the budget expires —
 * whichever lands first. Resolves `true` when the barrier settled properly and
 * `false` when it timed out (the caller reads either way; the flag exists so a
 * wedged pane is observable rather than silently slow).
 *
 * A synchronous throw from `write` (disposed terminal, xterm's pending-data
 * watermark) settles as a timeout too — there is nothing left to wait for.
 */
export function awaitParseBarrier(
  terminal: BarrierWritable,
  timeoutMs: number = PARSE_BARRIER_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (parsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parsed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      terminal.write('', () => finish(true));
    } catch {
      finish(false);
    }
  });
}
