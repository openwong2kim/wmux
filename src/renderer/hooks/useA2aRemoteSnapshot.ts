import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Workspace } from '../../shared/types';
import type { AgentSlug } from '../../shared/events';
import type { A2aRemotePaneSnapshot } from '../../shared/rpc';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { leafDisplayName } from '../utils/paneNaming';

/** Coalesce bursts (a split, a rename, a cwd change) into one send. */
export const A2A_SNAPSHOT_DEBOUNCE_MS = 400;

interface SnapshotSource {
  workspaces: Workspace[];
  surfaceAgent: Record<string, { name: string; slug?: AgentSlug }>;
  /** User pane labels (the header's source); absent in callers that have none. */
  paneLabel?: Record<string, string>;
}

/**
 * Every workspace and pane of this window as cross-host A2A needs them: the
 * names a human picks a pane by, the pane's agent, cwd and branch. Pure, so
 * the shape is testable without a store. This PC has no Moa any more, so
 * its brain end always reads as 'off' (main then ends a brain link left
 * from an earlier version instead of waiting on it).
 */
export function buildPaneSnapshot(s: SnapshotSource): A2aRemotePaneSnapshot {
  return {
    brainState: 'off',
    workspaces: s.workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      panes: getWorkspaceLeafPanes(ws).map((leaf) => {
        const surface = leaf.surfaces.find((x) => x.id === leaf.activeSurfaceId) ?? leaf.surfaces[0];
        const agent = surface?.ptyId ? s.surfaceAgent[surface.ptyId] : undefined;
        const label = leafDisplayName(s.paneLabel, ws, leaf, agent?.slug);
        const cwd = surface?.cwd || ws.metadata?.cwd;
        const agentName = agent?.slug ?? agent?.name;
        return {
          paneId: leaf.id,
          label,
          ...(agentName ? { agent: agentName } : {}),
          ...(cwd ? { cwd } : {}),
          ...(ws.metadata?.gitBranch ? { gitBranch: ws.metadata.gitBranch } : {}),
        };
      }),
    })),
  };
}

/**
 * Sends this window's pane tree to main whenever it changes, once the saved
 * session is restored (before that an empty tree would read as "every pane
 * closed" and break links). Main publishes the exposed part to the daemon and
 * reports gone panes. Desktop with a daemon only.
 */
export function useA2aRemoteSnapshot(): void {
  useEffect(() => {
    const api = window.electronAPI?.a2aRemote;
    if (!api?.snapshot) return;
    let lastKey = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      const state = useStore.getState();
      // Only after the startup load settled (a first run with no session
      // included): from here an empty tree is real (main believes it).
      if (!state.sessionRestored && !state.sessionLoadSettled) return;
      const snapshot: A2aRemotePaneSnapshot = { ...buildPaneSnapshot(state), sessionRestored: true };
      const key = JSON.stringify(snapshot);
      if (key === lastKey) return;
      lastKey = key;
      void api.snapshot(snapshot).catch(() => {
        // Retry on the next change.
        lastKey = '';
      });
    };
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(flush, A2A_SNAPSHOT_DEBOUNCE_MS);
    };
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (
        s.workspaces !== prev.workspaces ||
        s.surfaceAgent !== prev.surfaceAgent ||
        s.paneLabel !== prev.paneLabel ||
        s.sessionRestored !== prev.sessionRestored ||
        s.sessionLoadSettled !== prev.sessionLoadSettled
      ) schedule();
    });
    schedule();
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}

/** Offers already announced, so a re-sent or re-opened one is not toasted twice. */
const toastedOffers = new Set<string>();

/**
 * A link request, or a pane another PC shared, waits on this PC's human: say
 * so once, with a jump to the Remote page where its card is. Review only: the
 * names in it are the other PC's report.
 */
export function useA2aLinkRequestToast(t: (key: string) => string): void {
  useEffect(() => {
    const api = window.electronAPI?.a2aRemote;
    if (!api?.onLinkEvent) return;
    return api.onLinkEvent((event) => {
      let message: string;
      if (event.type === 'a2a.remote.link.proposed') message = t('a2aLink.requestToast');
      // The other PC accepted a share: say so at once, its link row names the pane it chose.
      else if (event.type === 'a2a.remote.offer.changed' && event.side === 'out' && event.state === 'accepted' && !toastedOffers.has(event.offerId)) {
        toastedOffers.add(event.offerId);
        message = t('a2aShare.acceptedToast');
      } else if (event.type === 'a2a.remote.offer.changed' && event.side === 'in' && event.state === 'open' && !toastedOffers.has(event.offerId)) {
        toastedOffers.add(event.offerId);
        message = t('a2aOffer.toast');
      } else return;
      useStore.getState().pushToast({
        message,
        level: 'info',
        action: { label: t('a2aLink.requestToastOpen'), onClick: () => useStore.getState().setAppRoute('remote') },
      });
    });
  }, [t]);
}
