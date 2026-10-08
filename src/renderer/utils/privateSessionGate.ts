/**
 * "Is the private-tab session ready to use?" — the renderer half of the clear
 * that runs when the last private tab closes.
 *
 * The clear is asynchronous and main waits for the closed tabs' guests to die
 * before wiping. A private tab opened in that window (close the last one, then
 * Cmd+Shift+N straight away, or an agent's close -> browser_open private:true)
 * would otherwise load first and have its cookies wiped by the clear meant for
 * the tab before it. So a private BrowserPanel does not mount its <webview>
 * until the pending clear has settled.
 */

let pending: Promise<void> | null = null;

/** Start a clear; private panels wait for it. A failed clear still settles. */
export function beginPrivateSessionClear(run: () => Promise<unknown> | undefined): void {
  let started: Promise<unknown>;
  try {
    started = Promise.resolve(run());
  } catch (err) {
    started = Promise.reject(err);
  }
  const current: Promise<void> = started
    .then(() => undefined, () => undefined)
    .then(() => {
      if (pending === current) pending = null;
    });
  pending = current;
}

/** True when no clear is in flight. */
export function isPrivateSessionReady(): boolean {
  return pending === null;
}

/** Resolves once every clear started so far has settled. */
export async function privateSessionReady(): Promise<void> {
  while (pending) await pending;
}
