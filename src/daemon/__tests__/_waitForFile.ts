// Shared test helper: poll a predicate until it holds (or a generous timeout
// elapses), instead of a fixed `setTimeout(50)` guess for async fs I/O to land.
//
// The debounced StateWriter/ChannelStateWriter tests switch from fake timers to
// real timers and then wait for a real `fsp.writeFile`/rename to complete. A
// fixed 50 ms wait is fine on an idle machine but flakes under parallel-fork
// load (many test files doing concurrent fs work) — the write simply hasn't
// landed yet, so the file-exists / content assertion sees stale state. Polling
// the actual condition removes the timing guess: it returns the instant the
// condition is met, and only falls through after the timeout so the real
// assertion still reports the true failure.
//
// NOT a .test.ts file, so the vitest include glob never runs it as a suite.

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = predicate();
    } catch {
      ok = false; // e.g. readFileSync before the file exists — treat as not-yet
    }
    if (ok) return;
    if (Date.now() - start >= timeoutMs) return; // let the caller's assertion report
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
