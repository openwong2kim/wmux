/**
 * The browser build's poll loop: GET `/api/workspaces` + `/api/sessions` every
 * few seconds and re-hydrate the store only when either reply's bytes changed.
 * GET only — this loop never writes to the daemon.
 */
import { useStore } from '../stores';
import {
  hydrateWebState,
  type ServerSelection,
  type WebSessionsReply,
  type WebWorkspacesReply,
} from './webHydration';
import type { Workspace } from '../../shared/types';

export const WEB_POLL_MS = 2500;

export interface WebSyncOptions {
  token: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** Called when the daemon refuses the credential (the pairing flow lives on `/`). */
  onUnauthorized: () => void;
}

export function startWebSync(opts: WebSyncOptions): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const headers = { Authorization: `Bearer ${opts.token}` };
  const cache = new Map<string, { key: string; built: Workspace }>();
  let lastServer: ServerSelection = { activePane: {}, activeSurface: {} };
  let lastText = '';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const get = async (path: string): Promise<string | null> => {
    const res = await fetchImpl(path, { method: 'GET', headers, cache: 'no-store' });
    if (res.status === 401) {
      stopped = true;
      opts.onUnauthorized();
      return null;
    }
    return res.ok ? res.text() : null;
  };

  const tick = async (): Promise<void> => {
    try {
      const [wsText, sessText] = await Promise.all([get('/api/workspaces'), get('/api/sessions')]);
      if (stopped || wsText === null) return;
      const text = `${wsText}\n${sessText ?? ''}`;
      if (text === lastText) return;
      lastText = text;
      const store = useStore.getState();
      const { state, server } = hydrateWebState({
        workspacesReply: JSON.parse(wsText) as WebWorkspacesReply,
        sessionsReply: sessText ? (JSON.parse(sessText) as WebSessionsReply) : null,
        current: { workspaces: store.workspaces, activeWorkspaceId: store.activeWorkspaceId },
        lastServer,
        cache,
      });
      lastServer = server;
      useStore.setState({ ...state, paneGate: 'ready' });
    } catch (err) {
      console.warn('[wmux web] sync failed', err);
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, opts.intervalMs ?? WEB_POLL_MS);
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
