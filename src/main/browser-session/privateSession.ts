import { app, session } from 'electron';
import { PRIVATE_BROWSER_PARTITION } from '../../shared/privateBrowser';

type ClearableSession = Pick<Electron.Session, 'clearStorageData' | 'clearCache' | 'clearAuthCache'>;

/** How long a clear waits for the closed tabs' guests to go away. */
const LIVE_WAIT_MS = 3_000;
const LIVE_POLL_MS = 50;

/** webContents ids currently alive on the private partition. */
const livePrivateContents = new Set<number>();

/**
 * Count every webContents created on the private partition until it is
 * destroyed. The renderer drops a private surface from its store before React
 * unmounts the <webview>, so a clear that ran at once could race a guest that
 * is still writing; the clear below waits for this count to reach zero.
 */
export function trackPrivateBrowserContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session !== session.fromPartition(PRIVATE_BROWSER_PARTITION)) return;
    const id = contents.id;
    livePrivateContents.add(id);
    contents.once('destroyed', () => { livePrivateContents.delete(id); });
  });
}

export interface ClearPrivateSessionDeps {
  session: ClearableSession;
  liveCount: () => number;
  waitMs?: number;
  pollMs?: number;
  warn?: (message: string, error: unknown) => void;
}

/**
 * Erase everything the shared private-tab session holds: cookies, storage,
 * HTTP cache and HTTP auth. The partition is in-memory already; this is what
 * makes closing the last private tab end the private session rather than wait
 * for the app to quit.
 *
 * Waits (bounded) until no private guest is alive, so the tab that just closed
 * cannot write after the wipe. Each part is cleared independently and a
 * failure is logged per part: one rejected clear must not hide whether the
 * others ran.
 */
export async function clearPrivateSession(deps: ClearPrivateSessionDeps): Promise<void> {
  const waitMs = deps.waitMs ?? LIVE_WAIT_MS;
  const pollMs = deps.pollMs ?? LIVE_POLL_MS;
  const warn = deps.warn ?? ((message: string, error: unknown) => console.warn(message, error));
  const deadline = Date.now() + waitMs;
  while (deps.liveCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const parts = ['storage', 'cache', 'auth cache'] as const;
  const results = await Promise.allSettled([
    deps.session.clearStorageData(),
    deps.session.clearCache(),
    deps.session.clearAuthCache(),
  ]);
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      warn(`[private-browser] clearing the private session's ${parts[i]} failed:`, result.reason);
    }
  });
}

export function clearPrivateBrowserSession(): Promise<void> {
  return clearPrivateSession({
    session: session.fromPartition(PRIVATE_BROWSER_PARTITION),
    liveCount: () => livePrivateContents.size,
  });
}
