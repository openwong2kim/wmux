/**
 * The browser build's poll loop: GET `/api/workspaces` + `/api/sessions` every
 * few seconds and re-hydrate the store only when either reply's bytes changed.
 * GET only — this loop never writes to the daemon.
 *
 * A poll is all-or-nothing: if either reply fails (network, timeout, non-2xx)
 * the store is left as it is and the next tick tries again, so a single failed
 * `/api/sessions` cannot blank every tab title and status for one interval.
 */
import { useStore } from '../stores';
import {
  hydrateWebState,
  type HydrationCacheEntry,
  type ServerSelection,
  type WebSessionsReply,
  type WebWorkspacesReply,
} from './webHydration';

export const WEB_POLL_MS = 2500;
/** Upper bound on one request, body included. */
export const WEB_POLL_TIMEOUT_MS = 10_000;

export interface WebSyncOptions {
  token: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  /** Called when the daemon refuses the credential (401/403); the pairing flow lives on `/`. */
  onUnauthorized: () => void;
}

class Refused extends Error {}

export function startWebSync(opts: WebSyncOptions): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const headers = { Authorization: `Bearer ${opts.token}` };
  const cache = new Map<string, HydrationCacheEntry>();
  let lastServer: ServerSelection = { activePane: {}, activeSurface: {} };
  let lastText = '';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;

  const get = async (path: string, signal: AbortSignal): Promise<string> => {
    const res = await fetchImpl(path, { method: 'GET', headers, cache: 'no-store', signal });
    if (res.status === 401 || res.status === 403) throw new Refused(`${path} ${res.status}`);
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.text();
  };

  const tick = async (): Promise<void> => {
    const ctl = new AbortController();
    inflight = ctl;
    const timeout = setTimeout(() => ctl.abort(), opts.timeoutMs ?? WEB_POLL_TIMEOUT_MS);
    try {
      const [wsText, sessText] = await Promise.all([
        get('/api/workspaces', ctl.signal),
        get('/api/sessions', ctl.signal),
      ]);
      if (stopped) return;
      const text = `${wsText}\n${sessText}`;
      if (text === lastText) return;
      const store = useStore.getState();
      const { state, server } = hydrateWebState({
        workspacesReply: JSON.parse(wsText) as WebWorkspacesReply,
        sessionsReply: JSON.parse(sessText) as WebSessionsReply,
        current: {
          workspaces: store.workspaces,
          activeWorkspaceId: store.activeWorkspaceId,
          surfaceTurnOpenAt: store.surfaceTurnOpenAt,
        },
        lastServer,
        cache,
      });
      lastText = text;
      lastServer = server;
      useStore.setState({ ...state, paneGate: 'ready' });
    } catch (err) {
      if (err instanceof Refused) {
        stopped = true;
        opts.onUnauthorized();
      } else if (!stopped) {
        console.warn('[wmux web] sync failed; retrying', err instanceof Error ? err.message : err);
      }
    } finally {
      clearTimeout(timeout);
      if (inflight === ctl) inflight = undefined;
      if (!stopped) timer = setTimeout(() => { void tick(); }, opts.intervalMs ?? WEB_POLL_MS);
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    inflight?.abort();
  };
}
