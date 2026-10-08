import { useEffect } from 'react';
import { useStore } from '../stores';
import type { A2aRemoteFeed } from '../stores/slices/a2aRemoteSlice';

/**
 * Held work has no daemon nudge, so it is re-read on this cadence — only
 * while the window is visible, and only the held list.
 */
export const A2A_HELD_POLL_MS = 30_000;

/** Refreshes started, and the newest one whose answers were applied. */
let started = 0;
let applied = 0;

/** Forget everything read so far: the daemon is gone, so nothing in it can be acted on. */
export function resetA2aRemote(): void {
  // A read still in flight from before the reset must not bring it back.
  applied = ++started;
  useStore.getState().setA2aRemote({ links: [], hosts: [], held: [], joined: [], peers: [], loaded: false });
}

/**
 * Re-read everything the Remote page and the rail badge show about other PCs.
 * Each source is read on its own, so one that fails (an older daemon) never
 * blanks the others; when every read fails the daemon is away and the feed is
 * cleared. Reads overlap freely: a refresh that finishes after a newer one
 * has already applied is dropped, so an old list never rolls the badge back.
 * Safe to call from anywhere: it reads, it does not subscribe.
 */
export async function refreshA2aRemote(only?: 'held'): Promise<void> {
  const api = window.electronAPI?.a2aRemote;
  if (!api?.linksList) return;
  const generation = ++started;
  const patch: Partial<A2aRemoteFeed> = {};
  let failed = 0;
  const read = async <T>(call: (() => Promise<T>) | undefined, apply: (v: T) => void): Promise<void> => {
    if (!call) return;
    try {
      apply(await call());
      patch.loaded = true;
    } catch {
      failed++;
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
  if (generation < applied) return;
  applied = generation;
  if (!patch.loaded && failed > 0) {
    resetA2aRemote();
    return;
  }
  if (Object.keys(patch).length > 0) useStore.getState().setA2aRemote(patch);
}

/**
 * The SINGLE owner of the cross-PC A2A subscriptions behind the Remote page
 * and its rail badge. Mounted once in AppLayout, always on: reads at start,
 * on every link or host-status nudge and on a daemon reconnect (and clears
 * on a disconnect), plus the
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
      window.electronAPI as unknown as {
        daemon?: { onConnected?: (cb: () => void) => () => void; onDisconnected?: (cb: () => void) => () => void };
      }
    ).daemon;
    const offDaemon = daemonApi?.onConnected?.(() => void refreshA2aRemote());
    // Requests and held work from a daemon that is gone cannot be acted on.
    const offGone = daemonApi?.onDisconnected?.(() => resetA2aRemote());
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshA2aRemote('held');
    }, A2A_HELD_POLL_MS);
    return () => {
      offLink?.();
      offHost?.();
      offDaemon?.();
      offGone?.();
      window.clearInterval(poll);
    };
  }, []);
}
