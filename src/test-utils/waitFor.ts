/**
 * Wait for a condition instead of sleeping a fixed span.
 *
 * TEST-ONLY. Nothing in `src/` outside a test should import this; production
 * code that needs to wait for something should be given an event, not a poll.
 *
 * ── Why this exists as one shared thing ────────────────────────────────────
 * Four test files had defined their own byte-identical copy, and a fifth had
 * open-coded the same idea as `setTimeout(50)`. That last one is the reason
 * this file exists: `DaemonPipeServer.os.test.ts` slept 50ms as a stand-in for
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

/**
 * Sleep a fixed span ON PURPOSE. The one sanctioned fixed sleep in a test.
 *
 * Test files may not write `await new Promise((r) => setTimeout(r, N))` or call
 * a local `sleep(N)`/`delay(N)`/`wait(N)` (lint: no-restricted-syntax in the
 * test-file override of .eslintrc.json). Everything above says why. A fixed
 * wait is still right in a few places, and this is how a test says it is one:
 *
 * - a NEGATIVE check: "after 200ms the callback has still not fired". There is
 *   no condition to wait for; the span is the claim.
 * - a real product timer that must elapse, where fake timers cannot be used
 *   (a child process, a real socket or browser, a debounce under React act).
 * - simulated latency inside a stub ("a slow git call"), or putting two
 *   timestamps apart.
 *
 * It is NOT for "wait until X, then assert X". That is `vi.waitFor(() =>
 * expect(X)..., { timeout: 10_000 })` (5_000 when X is in-memory state), or
 * `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)` when the thing being
 * waited for is a timer.
 *
 * `why` is required and must say which of the cases above this is, so the next
 * reader (and the next flake hunt) does not have to work it out again.
 */
export function deliberateSleep(ms: number, why: string): Promise<void> {
  if (!why.trim()) throw new Error('deliberateSleep: say why this fixed sleep is not a wait for something');
  return new Promise((resolve) => setTimeout(resolve, ms));
}
