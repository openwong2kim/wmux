import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import type { RemoteAttachmentDescriptor } from '../../shared/remoteHosts';

// ─── Remote attachment lifecycle ─────────────────────────────────────────────
//
// The SINGLE owner of two things AppLayout has no other place for:
//
//  ① RESTORE. remoteWorkspacesSlice is memory-only, so a reload (Cmd+R) or an
//     app restart recreates it empty. Main persists the descriptors; this hook
//     replays them on boot, re-fetching each host's CURRENT panes rather than
//     trusting anything on disk. A host that cannot be reached, or a workspace
//     that no longer exists there, is restored in a `stale` state instead of
//     being dropped — a sleeping laptop must not delete the user's attachment.
//
//  ② PANE MEMBERSHIP. The remote wire carries no topology events, so pane
//     open/close on the remote never reaches us directly. A pane CLOSE does
//     surface indirectly (its PTY dies → SSE exit → REMOTE_PANE_EXIT), which
//     is used here as a refresh trigger; a pane OPEN produces nothing at all,
//     which is what the 10s poll is for. Both go through the same
//     refetch-and-diff, and both are debounced/serialised so an exit burst
//     costs one round of requests. No daemon-side change is involved, so this
//     keeps working against older remote builds (version skew is real here).
//
// Actions are read via useStore.getState() so the effect deps stay minimal —
// mirrors useRemoteInboxBridge.

/** An exit burst (a whole remote workspace being closed) must collapse into
 *  one refetch. */
const REFRESH_DEBOUNCE_MS = 400;

/** Safety net for pane OPENS, which produce no event on this wire. */
const POLL_INTERVAL_MS = 10_000;

export function useRemoteAttachmentsLifecycle(): void {
  // A refresh round is serialised: while one is in flight, further triggers
  // set `pending` and are coalesced into a single follow-up round.
  const inFlight = useRef(false);
  const pending = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const refreshRef = useRef<() => Promise<void>>(async () => { /* replaced below */ });
  refreshRef.current = async (): Promise<void> => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    inFlight.current = true;
    try {
      const store = useStore.getState();
      // One workspacesList per HOST, not per attached workspace — several
      // mirrors of the same machine share a single round trip.
      const hostIds = [...new Set(store.remoteWorkspaces.map((w) => w.hostId))];
      for (const hostId of hostIds) {
        let res: Awaited<ReturnType<typeof remote.workspacesList>>;
        try {
          res = await remote.workspacesList(hostId);
        } catch (err) {
          res = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (unmounted.current) return;
        // Re-read: an attach/detach may have landed while that request was
        // in flight.
        const attached = useStore.getState().remoteWorkspaces.filter((w) => w.hostId === hostId);
        for (const w of attached) {
          if (!res.ok) {
            useStore.getState().setRemoteWorkspaceStale(w.key, true);
            continue;
          }
          const found = res.workspaces.find((ws) => ws.id === w.workspaceId);
          if (!found) {
            // The workspace is gone from the host (every pane closed) — keep
            // the row, flag it, and let the user decide.
            useStore.getState().setRemoteWorkspaceStale(w.key, true);
            continue;
          }
          useStore.getState().setRemoteWorkspacePanes(w.key, found.panes);
        }
      }
    } finally {
      inFlight.current = false;
      if (pending.current && !unmounted.current) {
        pending.current = false;
        void refreshRef.current();
      }
    }
  };

  // ① Boot restore — once per renderer lifetime.
  useEffect(() => {
    unmounted.current = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    let cancelled = false;

    void (async () => {
      let descriptors: RemoteAttachmentDescriptor[];
      try {
        descriptors = await remote.attachmentsList();
      } catch {
        return; // older preload bundle / main not ready — nothing to restore
      }
      if (cancelled || descriptors.length === 0) return;

      const byHost = new Map<string, RemoteAttachmentDescriptor[]>();
      for (const d of descriptors) {
        const list = byHost.get(d.hostId);
        if (list) list.push(d);
        else byHost.set(d.hostId, [d]);
      }

      for (const [hostId, group] of byHost) {
        let res: Awaited<ReturnType<typeof remote.workspacesList>> | null = null;
        try {
          res = await remote.workspacesList(hostId);
        } catch {
          res = null; // unreachable host → every descriptor on it restores stale
        }
        if (cancelled) return;
        for (const d of group) {
          const found = res?.ok ? res.workspaces.find((ws) => ws.id === d.workspaceId) : undefined;
          useStore.getState().restoreRemoteWorkspace({
            key: d.key,
            hostId: d.hostId,
            hostLabel: d.hostLabel,
            workspaceId: d.workspaceId,
            name: found?.name ?? d.name,
            // Panes ALWAYS come from the live fetch, never from disk.
            panes: found?.panes ?? [],
            stale: !found,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      unmounted.current = true;
    };
  }, []);

  // ②-a Exit events → debounced refetch. Subscribed once; an exit carries only
  //     an attachId, so the refresh covers every attached host rather than
  //     trying to map it back to one workspace.
  useEffect(() => {
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    const off = remote.onPaneExit(() => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void refreshRef.current();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, []);

  // ②-b Safety-net poll — armed only while something is attached, so an app
  //     with no mirrors makes no periodic requests at all.
  const hasAttachments = useStore((s) => s.remoteWorkspaces.length > 0);
  useEffect(() => {
    if (!hasAttachments) return;
    const id = setInterval(() => { void refreshRef.current(); }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasAttachments]);
}
