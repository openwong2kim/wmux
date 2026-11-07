import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectPcRailFeedStale } from '../../stores/selectors/pcRail';
import { isPcRailHostOnline } from '../../../shared/pcRail';
import { t } from '../../i18n';
import { noWorkspaceGrantMessage } from '../Remote/noWorkspaceGrant';
import type { PcRailBridge } from '../../../preload/preload';

/** How long to wait for the new workspace's row before leaving it to the list. */
const ROW_WAIT_MS = 30_000;

/** Names sent for workspaces the host has not listed yet, per host, so a quick
 *  second `+` (from either sidebar) does not pick the same number. */
const pendingNames = new Map<string, Set<string>>();

/** "Workspace N" with the lowest N the host's list does not use, as the local `+` names one. */
export function nextRemoteWorkspaceName(names: readonly string[]): string {
  const used = new Set(names.map((name) => /^Workspace (\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number));
  let n = 1;
  while (used.has(n)) n++;
  return `Workspace ${n}`;
}

/**
 * The sidebar's `+` for a paired computer: creates a workspace ON that host
 * (a real shell pane there, through REMOTE_WORKSPACE_CREATE), asks the rail to
 * poll the host now, and opens the workspace once its row arrives. Only hosts
 * whose roster entry says `canCreateWorkspace` offer it; nothing local is made.
 */
export function useRemoteWorkspaceCreate(hostId: string | null): {
  canCreate: boolean;
  /** The host is reachable and its list is fresh, as the list itself reads it. */
  online: boolean;
  creating: boolean;
  create: () => void;
} {
  const canCreate = useStore((s) => !!hostId && s.pcRailHosts.some((h) => h.id === hostId && h.canCreateWorkspace === true));
  const online = useStore((s) => !!hostId && isPcRailHostOnline(s.pcRailHostStatus[hostId] ?? 'reachable') && !selectPcRailFeedStale(s, hostId));
  const [creating, setCreating] = useState(false);
  const stopWaiting = useRef<(() => void) | null>(null);
  // The host this sidebar shows now; null once unmounted. A create that
  // answers after the person moved on opens nothing and changes no route.
  const liveHost = useRef<string | null>(hostId);
  useEffect(() => {
    liveHost.current = hostId;
    return () => {
      liveHost.current = null;
      stopWaiting.current?.();
    };
  }, [hostId]);

  const create = useCallback(() => {
    const remote = window.electronAPI?.remote;
    if (!hostId || creating || !online || !remote?.workspaceCreate) return;
    setCreating(true);
    const workspaceId = crypto.randomUUID();
    const pending = pendingNames.get(hostId) ?? new Set<string>();
    const name = nextRemoteWorkspaceName([...(useStore.getState().pcRailFeeds[hostId]?.workspaces ?? []).map((w) => w.name), ...pending]);
    pending.add(name);
    pendingNames.set(hostId, pending);
    // Held for the row wait (or until the create fails); by then the host's list counts it.
    const releaseName = () => {
      pending.delete(name);
      if (pending.size === 0 && pendingNames.get(hostId) === pending) pendingNames.delete(hostId);
    };
    setTimeout(releaseName, ROW_WAIT_MS);
    void (async () => {
      try {
        const res = await remote.workspaceCreate(hostId, workspaceId, undefined, name);
        if (!res.ok) {
          releaseName();
          if (res.reason === 'auth-rejected') useStore.getState().setRemoteHostAuthRejected(hostId, true);
          const pc = useStore.getState().pcRailHosts.find((h) => h.id === hostId)?.label ?? hostId;
          const message = noWorkspaceGrantMessage(t, res.reason, pc) ?? t('remote.createWorkspaceFailed', { error: res.error });
          useStore.getState().pushToast({ message, level: 'error' });
          return;
        }
      } catch (err) {
        releaseName();
        useStore.getState().pushToast({
          message: t('remote.createWorkspaceFailed', { error: err instanceof Error ? err.message : String(err) }),
          level: 'error',
        });
        return;
      } finally {
        setCreating(false);
      }
      if (liveHost.current !== hostId) return;
      openWhenListed(hostId, workspaceId, stopWaiting);
      const pcRail = (window.electronAPI as unknown as { pcRail?: PcRailBridge } | undefined)?.pcRail;
      void pcRail?.refresh?.({ hostId }).catch(() => undefined);
    })();
  }, [hostId, creating, online]);

  return { canCreate, online, creating, create };
}

/** Open the shadow workspace as soon as the host lists it; give up after ROW_WAIT_MS. */
function openWhenListed(hostId: string, workspaceId: string, stopWaiting: { current: (() => void) | null }): void {
  stopWaiting.current?.();
  const tryOpen = (): boolean => {
    const st = useStore.getState();
    // The person switched computers meanwhile: the row is listed there, nothing opens.
    if (st.pcRail.activePcId !== hostId) return true;
    if (!st.pcRailFeeds[hostId]?.workspaces.some((w) => w.id === workspaceId)) return false;
    if (st.openShadowWorkspace(hostId, workspaceId) === null) return false;
    st.setAppRoute('workspaces');
    return true;
  };
  if (tryOpen()) return;
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.pcRailFeeds !== prev.pcRailFeeds && tryOpen()) stop();
  });
  const timer = setTimeout(() => stop(), ROW_WAIT_MS);
  const stop = () => {
    unsubscribe();
    clearTimeout(timer);
    if (stopWaiting.current === stop) stopWaiting.current = null;
  };
  stopWaiting.current = stop;
}
