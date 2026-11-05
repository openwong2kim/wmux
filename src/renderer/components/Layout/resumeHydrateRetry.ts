/**
 * The resume hydrate after a daemon (re)connect, tried again when its
 * `pty.list` fails (#3028). After a replaced daemon the renderer drops every
 * pane's resume offer and claim, and this hydrate is what brings them back:
 * one failed list left those panes with no Resume pill and no automatic
 * resume for the rest of the run (the 15 s poll refreshes bindings, never
 * offers). The retries stop once the connection they belong to is gone.
 */

/** The waits before each further try of a failed hydrate. */
export const RESUME_HYDRATE_RETRY_MS: readonly number[] = [1_000, 3_000, 9_000];

/**
 * Run `hydrate`, and while it fails, again after each wait in
 * RESUME_HYDRATE_RETRY_MS, as long as `current()` still holds (the daemon
 * connection it was started for). Returns a cancel for the pending try.
 */
export function hydrateWithRetry(hydrate: () => Promise<unknown>, current: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const run = (tries: number): void => {
    hydrate().catch(() => {
      if (cancelled || tries >= RESUME_HYDRATE_RETRY_MS.length) return;
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled && current()) run(tries + 1);
      }, RESUME_HYDRATE_RETRY_MS[tries]);
    });
  };
  run(0);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
