/**
 * PC rail: one paired computer's workspace list, as a store the sidebar's own
 * row components read (RowStoreContext, rowStore.ts). Every row then renders
 * exactly as this computer's rows do: ordinal, status mark, needs-you card,
 * idle label, branch line, the expandable pane rows with their agent and
 * "w1-1" tag.
 *
 * The store is the app state with a few keys replaced, built from what the
 * host sends (pcRailFeeds): its workspaces as shadow-id trees, its agents as
 * remote entries (resolveRemoteAgent reads them), its pane names, its last
 * output times. What the host does not send stays empty, so it is not drawn.
 * `readOnly` is set: rows offer no rename, menu, drag, drop or other local
 * action; selecting a row is the caller's (it opens the shadow workspace).
 */
import { useEffect, useMemo } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore, type StoreState } from './index';
import { buildShadowWorkspace } from './shadowWorkspace';
import { comparePcRailRows, formatShadowWorkspaceId, isPcRailFeedStale, parseShadowWorkspaceId, type PcRailWorkspaceRow } from '../../shared/pcRail';
import { remoteAgentKey, remoteAttachmentKey } from '../../shared/remoteHosts';
import type { Pane, PaneLeaf, Workspace } from '../../shared/types';
import type { AttachedRemoteWorkspace } from './slices/remoteWorkspacesSlice';

/** The keys a host list replaces; everything else reads through to the app state. */
export type HostRowOverrides = Pick<StoreState,
  | 'workspaces' | 'remoteWorkspaces' | 'paneLabel' | 'surfaceActivityAt' | 'surfaceOutputAt'
  | 'readOnly' | 'sidebarPinnedIds' | 'sidebarBookmarkedIds' | 'sidebarSortMode' | 'notifications'
  | 'workspaceSettle' | 'projectConfigs' | 'departedPaneGroups' | 'missionByPaneGroup' | 'stashPulse'
  | 'sidebarShowPaneCoordinates'>;

const COPY = { browserNotShown: '', openElsewhere: () => '', terminal: '' };

function leavesOf(pane: Pane, out: PaneLeaf[] = []): PaneLeaf[] {
  if (pane.type === 'leaf') out.push(pane);
  else for (const child of pane.children) leavesOf(child, out);
  return out;
}

/** One host row as a workspace tree with the host's own tab titles. */
function rowWorkspace(hostId: string, row: PcRailWorkspaceRow, alias: AttachedRemoteWorkspace | undefined, open: Workspace | undefined): Workspace | null {
  const id = formatShadowWorkspaceId(hostId, row.id);
  if (!id) return null;
  const name = alias?.label || row.name || row.id;
  const metadata = {
    ...(row.gitBranch ? { gitBranch: row.gitBranch } : {}),
    ...(row.gitIsWorktree !== undefined ? { gitIsWorktree: row.gitIsWorktree } : {}),
  };
  const color = (alias?.color ?? row.color) as Workspace['color'];
  const built = buildShadowWorkspace(hostId, row, COPY, () => null);
  if (!built) {
    // An `empty` row: the workspace exists on the host with no terminal.
    const leafId = `${id}#f:`;
    return { id, name, color, metadata, rootPane: { id: leafId, type: 'leaf', surfaces: [], activeSurfaceId: '' }, activePaneId: leafId };
  }
  const titles = new Map(row.panes.map((p) => [p.sessionId, p.surfaceTitle ?? '']));
  const retitle = (pane: Pane): Pane => {
    if (pane.type === 'branch') return { ...pane, children: pane.children.map(retitle) };
    // The open shadow's own tab choice wins, so its focused pane row matches.
    const openLeaf = open ? leavesOf(open.rootPane).find((l) => l.id === pane.id) : undefined;
    const activeSurfaceId = openLeaf && pane.surfaces.some((s) => s.id === openLeaf.activeSurfaceId) ? openLeaf.activeSurfaceId : pane.activeSurfaceId;
    return {
      ...pane,
      activeSurfaceId,
      surfaces: pane.surfaces.map((s) => (s.surfaceType === 'remote-terminal' && s.remoteSessionId ? { ...s, title: titles.get(s.remoteSessionId) ?? '' } : s)),
    };
  };
  const rootPane = retitle(built.rootPane);
  const activePaneId = open && leavesOf(rootPane).some((l) => l.id === open.activePaneId) ? open.activePaneId : built.activePaneId;
  return { ...built, name, color, metadata, rootPane, activePaneId };
}

/**
 * The replaced keys for `hostId`, from the app state. Pure: the same inputs
 * give equal output (the rows' selectors memoize on their inputs).
 */
export function buildHostRowOverrides(real: StoreState, hostId: string): HostRowOverrides {
  const feed = real.pcRailFeeds[hostId];
  const hostLabel = real.pcRailHosts.find((h) => h.id === hostId)?.label || hostId;
  const stale = !feed || isPcRailFeedStale(feed);
  const rows = feed ? [...feed.workspaces].sort(comparePcRailRows) : [];
  const workspaces: Workspace[] = [];
  const remote: AttachedRemoteWorkspace[] = [];
  const paneLabel: Record<string, string> = {};
  const activity: Record<string, number> = {};
  const pinned: string[] = [];
  for (const row of rows) {
    const alias = real.remoteWorkspaces.find((w) => w.key === remoteAttachmentKey(hostId, row.id) && !w.ephemeral);
    const open = real.workspaces.find((w) => w.id === formatShadowWorkspaceId(hostId, row.id));
    const ws = rowWorkspace(hostId, row, alias, open);
    if (!ws) continue;
    workspaces.push(ws);
    if (row.pinned) pinned.push(ws.id);
    // What the host's agents are doing: resolveRemoteAgent reads these. A
    // stale list carries none, so nothing old is drawn as current.
    remote.push({ key: `pcrail:${hostId}:${row.id}`, hostId, hostLabel, workspaceId: row.id, name: row.name, panes: row.panes, stale, ephemeral: true });
    for (const p of row.panes) if (p.lastActivityAt) activity[remoteAgentKey(hostId, p.sessionId)] = p.lastActivityAt;
    const names = new Map(row.panes.map((p) => [p.sessionId, p.paneName]));
    for (const leaf of leavesOf(ws.rootPane)) {
      const name = leaf.surfaces.map((s) => (s.remoteSessionId ? names.get(s.remoteSessionId) : undefined)).find(Boolean);
      if (name) paneLabel[leaf.id] = name;
    }
  }
  return {
    workspaces,
    remoteWorkspaces: [...remote, ...real.remoteWorkspaces],
    paneLabel,
    surfaceActivityAt: activity,
    surfaceOutputAt: activity,
    readOnly: true,
    sidebarPinnedIds: pinned,
    sidebarBookmarkedIds: [],
    sidebarSortMode: 'manual',
    notifications: [],
    workspaceSettle: { ...real.workspaceSettle, states: {}, hqWorkspaceId: null },
    projectConfigs: {},
    departedPaneGroups: {},
    missionByPaneGroup: {},
    stashPulse: null,
    // The host's pane names are its own; never hide them behind this setting.
    sidebarShowPaneCoordinates: true,
  };
}

/**
 * The app state seen through `overrides`. The proxy's target is an empty
 * object, not the app state: immer freezes that, and a proxy may not answer a
 * frozen target's own property with a different value.
 */
export function overlayHostRows(real: StoreState, overrides: HostRowOverrides): StoreState {
  const own = (key: string | symbol) => Object.prototype.hasOwnProperty.call(overrides, key);
  return new Proxy({} as StoreState, {
    get: (_target, key) => (own(key) ? overrides[key as keyof HostRowOverrides] : Reflect.get(real, key)),
    has: (_target, key) => own(key) || Reflect.has(real, key),
  });
}

/**
 * A store of one host's rows that follows the app store. The overrides are
 * rebuilt only when what they are built from changes; any other change is
 * passed through as is.
 */
export function useHostRowStore(hostId: string): StoreApi<StoreState> {
  const api = useMemo(() => {
    const real = useStore.getState();
    return createStore<StoreState>(() => overlayHostRows(real, buildHostRowOverrides(real, hostId)));
  }, [hostId]);
  useEffect(() => {
    let inputs: unknown[] = [];
    let overrides: HostRowOverrides | null = null;
    const sync = (real: StoreState) => {
      // Only this host's open shadows feed the rows (their focused tab), so a
      // change to a local workspace rebuilds nothing here.
      const shadows = real.workspaces.filter((w) => parseShadowWorkspaceId(w.id)?.hostId === hostId);
      const next = [real.pcRailFeeds[hostId], real.pcRailHosts, real.remoteWorkspaces, real.workspaceSettle, ...shadows];
      if (!overrides || next.length !== inputs.length || next.some((v, i) => v !== inputs[i])) {
        inputs = next;
        overrides = buildHostRowOverrides(real, hostId);
      }
      api.setState(overlayHostRows(real, overrides), true);
    };
    sync(useStore.getState());
    return useStore.subscribe(sync);
  }, [api, hostId]);
  return api;
}
