import { useEffect } from 'react';
import { useStore } from '../stores';
import type { A2aRemoteFeed } from '../stores/slices/a2aRemoteSlice';

/**
 * Held work has no daemon nudge, so it is re-read on this cadence — only
 * while the window is visible, and only the held list.
 */
export const A2A_HELD_POLL_MS = 30_000;

/**
 * Re-read everything the Remote page and the rail badge show about other PCs.
 * Each source is read on its own, so one that fails (an older daemon, a
 * restart) never blanks the others. Safe to call from anywhere: it reads,
 * it does not subscribe.
 */
export async function refreshA2aRemote(only?: 'held'): Promise<void> {
  const api = window.electronAPI?.a2aRemote;
  if (!api?.linksList) return;
  const patch: Partial<A2aRemoteFeed> = {};
  const read = async <T>(call: (() => Promise<T>) | undefined, apply: (v: T) => void): Promise<void> => {
    if (!call) return;
    try {
      apply(await call());
      patch.loaded = true;
    } catch {
      // The daemon is away; the next nudge or read tries again.
    }
  };
  await Promise.all([
    read(api.heldList, (v) => { if (Array.isArray(v?.tasks)) patch.held = v.tasks; }),
    ...(only === 'held' ? [] : [
      read(api.linksList, (v) => { if (Array.isArray(v?.links)) patch.links = v.links; }),
      read(api.hostsStatus, (v) => { if (Array.isArray(v?.hosts)) patch.hosts = v.hosts; }),
      read(api.hostsList, (v) => { if (Array.isArray(v?.hosts)) patch.joined = v.hosts; }),
      read(api.peersList, (v) => {
        if (Array.isArray(v?.peers)) patch.peers = v.peers.filter((p) => p.revokedAt === undefined);
      }),
    ]),
  ]);
  if (Object.keys(patch).length > 0) useStore.getState().setA2aRemote(patch);
}

/**
 * The SINGLE owner of the cross-PC A2A subscriptions behind the Remote page
 * and its rail badge. Mounted once in AppLayout, always on: reads at start,
 * on every link or host-status nudge and on a daemon reconnect, plus the
 * held list on a slow cadence while the window is visible.
 */
export function useA2aRemoteBridge(): void {
  useEffect(() => {
    const api = window.electronAPI?.a2aRemote;
    if (!api?.linksList) return;
    void refreshA2aRemote();
    const offLink = api.onLinkEvent?.(() => void refreshA2aRemote());
    const offHost = api.onHostStatus?.(() => void refreshA2aRemote());
    const daemonApi = (
      window.electronAPI as unknown as { daemon?: { onConnected?: (cb: () => void) => () => void } }
    ).daemon;
    const offDaemon = daemonApi?.onConnected?.(() => void refreshA2aRemote());
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshA2aRemote('held');
    }, A2A_HELD_POLL_MS);
    return () => {
      offLink?.();
      offHost?.();
      offDaemon?.();
      window.clearInterval(poll);
    };
  }, []);
}
