import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Workspace } from '../../shared/types';
import type { AgentSlug } from '../../shared/events';
import type { A2aRemotePaneSnapshot } from '../../shared/rpc';
import type { A2aLinkRecordV1 } from '../../shared/a2aRemote';
import type { MoaState } from '../../shared/moa';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { leafDisplayName } from '../utils/paneNaming';

/** Coalesce bursts (a split, a rename, a cwd change) into one send. */
export const A2A_SNAPSHOT_DEBOUNCE_MS = 400;

interface SnapshotSource {
  workspaces: Workspace[];
  surfaceAgent: Record<string, { name: string; slug?: AgentSlug }>;
  /** User pane labels (the header's source); absent in callers that have none. */
  paneLabel?: Record<string, string>;
  /** Main's Moa state; null/absent = unknown, treated as no Moa. */
  moa?: MoaState | null;
}

/** This PC's Moa as a link end: on, with a live HQ workspace. Otherwise null. */
export function moaBrainEnd(s: SnapshotSource): { workspaceId: string; name: string } | null {
  const hq = s.moa?.hq;
  if (!s.moa?.config.enabled || hq?.state !== 'ok' || !hq.workspaceId) return null;
  const ws = s.workspaces.find((w) => w.id === hq.workspaceId);
  return ws ? { workspaceId: ws.id, name: ws.name } : null;
}

/**
 * Every workspace and pane of this window as cross-host A2A needs them: the
 * names a human picks a pane by, the pane's agent, cwd and branch, plus this
 * PC's Moa while it is on. Pure, so
 * the shape is testable without a store.
 */
/**
 * How sure we are about this PC's Moa. 'off' only when that is settled (Moa
 * turned off, or no HQ / HQ deleted); a state not read yet, an unreadable HQ
 * store or an HQ not in the tree right now is 'unknown', which main rides out
 * on the last known Moa instead of breaking its links.
 */
export function moaBrainState(s: SnapshotSource): 'present' | 'off' | 'unknown' {
  if (moaBrainEnd(s)) return 'present';
  if (!s.moa) return 'unknown';
  if (!s.moa.config.enabled) return 'off';
  const hq = s.moa.hq;
  if (hq.state === 'unset' || hq.state === 'hq-missing') return 'off';
  return 'unknown';
}

export function buildPaneSnapshot(s: SnapshotSource): A2aRemotePaneSnapshot {
  const brain = moaBrainEnd(s);
  return {
    ...(brain ? { brain } : {}),
    brainState: moaBrainState(s),
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
        s.moa !== prev.moa ||
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

/**
 * Whether a link request can be accepted straight from its toast: a pane
 * link whose other end is on the same repo as this PC's pane. Anything else
 * (a Moa link, another repo, a repo not known on either side) is reviewed on
 * the Remote page.
 */
export function sameRepoPaneRequest(link: A2aLinkRecordV1, localRepo: string | null): boolean {
  return link.local.kind === 'pane' && link.remote.kind === 'pane'
    && !!link.remote.gitRemote && !!localRepo && link.remote.gitRemote === localRepo;
}

/**
 * A link request from another PC waits on this PC's human: say so once. The
 * toast offers Accept only for a same-repo pane link; otherwise it jumps to
 * the Remote page, where the request sits in the Needs you block.
 */
export function useA2aLinkRequestToast(t: (key: string) => string): void {
  useEffect(() => {
    const api = window.electronAPI?.a2aRemote;
    if (!api?.onLinkEvent) return;
    const review = { label: t('a2aLink.requestToastOpen'), onClick: () => useStore.getState().setAppRoute('remote') };
    return api.onLinkEvent((event) => {
      if (event.type !== 'a2a.remote.link.proposed') return;
      void (async () => {
        let action = review;
        try {
          const link = (await api.linksList())?.links?.find((l) => l.linkId === event.linkId);
          const s = useStore.getState();
          const pane = link?.local.kind === 'pane'
            ? buildPaneSnapshot({ workspaces: s.workspaces, surfaceAgent: s.surfaceAgent })
              .workspaces.find((w) => w.id === link.local.workspaceId)?.panes.find((x) => x.paneId === link.local.paneId)
            : undefined;
          const repo = pane?.cwd ? (await window.electronAPI?.github?.repoKey(pane.cwd).catch(() => null))?.key ?? null : null;
          if (link && sameRepoPaneRequest(link, repo)) {
            action = {
              label: t('a2aLink.accept'),
              onClick: () => {
                void api.linksAccept(event.linkId).then((r) => {
                  if (!r.ok) useStore.getState().pushToast({ message: t('a2aLink.error.failed'), level: 'error', action: review });
                }, () => undefined);
              },
            };
          }
        } catch {
          /* the daemon is away: Review still leads to the page */
        }
        useStore.getState().pushToast({ message: t('a2aLink.requestToast'), level: 'info', action });
      })();
    });
  }, [t]);
}
