/**
 * Wait for a condition instead of sleeping a fixed span.
 *
 * TEST-ONLY. Nothing in `src/` outside a test should import this; production
 * code that needs to wait for something should be given an event, not a poll.
 *
 * ── Why this exists as one shared thing ────────────────────────────────────
 * Four test files had defined their own byte-identical copy, and a fifth had
 * open-coded the same idea as `setTimeout(50)`. That last one is the reason
 * this file exists: `DaemonPipeServer.test.ts` slept 50ms as a stand-in for
 * "the server has registered this socket", and on a loaded windows-latest
 * runner the sleep finished first. The socket was not yet in the server's set,
 * `rotateToken()` did not drop it, and the test hung until vitest killed it at
 * 5000ms with no indication of what it had been waiting for.
 *
 * A fixed sleep is a guess about how long something else will take. It is
 * simultaneously too short (it flakes on a busy machine) and too long (every
 * fast run pays it), and when it loses, the failure names nothing.
 *
 * ── The label ──────────────────────────────────────────────────────────────
 * Defaults to the predicate's own source text, which is usually a better
 * description than anything a caller would type, and costs the caller nothing:
 *
 *   waitFor(() => server.getConnectionCount() === 1)
 *   → "waitFor: () => server.getConnectionCount() === 1 did not hold within 4000ms"
 *
 * The three copies this replaces all threw a bare "waitFor: deadline exceeded",
 * which put their failures in exactly the position the flake above was in.
 */

/** Long enough for a contended CI runner, short enough to stay under a 5s test timeout. */
export const DEFAULT_WAIT_TIMEOUT_MS = 4_000;

/** How often the predicate is re-checked. Cheap; the predicates are memory reads. */
const POLL_INTERVAL_MS = 5;

/** Keep a runaway arrow function from producing an unreadable failure message. */
const MAX_LABEL_CHARS = 120;

export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  label?: string,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor: ${label ?? describe(predicate)} did not hold within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function describe(predicate: () => boolean): string {
  const source = String(predicate).replace(/\s+/g, ' ').trim();
  return source.length > MAX_LABEL_CHARS ? `${source.slice(0, MAX_LABEL_CHARS)}…` : source;
}
