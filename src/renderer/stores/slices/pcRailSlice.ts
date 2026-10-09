/**
 * PC rail — renderer state for the computer column (contract: shared/pcRail).
 *
 *   main PcRailHub ──feed / attention / stream──▶ usePcRailFeeds ──▶ this slice
 *                                                                     │
 *   selectors/pcRail.ts (column, scoped sidebar, shadows) ◀───────────┘
 *
 * Only `pcRail` (activePcId, lastWorkspaceByPc, mutedPcs) is persisted, as
 * the optional `pcRail` field of session.json, through parsePcRailPersisted.
 * Everything else here is memory only: host rows, feeds, seen stamps and the
 * attention ledger. Shadow workspace ids are refused on every write path, so
 * a shadow can never reach the persisted state.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { RemoteHostStatus } from '../../../shared/remoteHosts';
import {
  DEFAULT_PC_RAIL_PERSISTED,
  LOCAL_PC_ID,
  PC_RAIL_LIMITS,
  applyPcRailAttentionFrame,
  isShadowWorkspaceId,
  parsePcRailPersisted,
  prunePcRailPersisted,
  reconcilePcRailApprovals,
  type PcId,
  type PcRailAttentionEvent,
  type PcRailHostFeed,
  type PcRailPendingLedger,
  type PcRailPersisted,
  type RemoteApprovalSummary,
} from '../../../shared/pcRail';
import type { PcRailFeedEvent, PcRailFeedFailure, PcRailHostInfo } from '../../../main/remote/pcRailWire';

export interface PcRailSlice {
  /** Persisted: the selected computer, the last workspace per computer, muted hosts. */
  pcRail: PcRailPersisted;
  /** Web-paired hosts in main's order. Empty until main's first roster. */
  pcRailHosts: PcRailHostInfo[];
  /** True once main sent a roster; persisted host state is pruned only after that. */
  pcRailHostsLoaded: boolean;
  /** hostId → status derived from its last poll tick. */
  pcRailHostStatus: Record<string, RemoteHostStatus>;
  pcRailFeeds: Record<string, PcRailHostFeed>;
  /** hostId → remote workspace id → epoch ms the user last viewed it. */
  pcRailHostSeen: Record<string, Record<string, number>>;
  /** hostId → what the rail believes is pending there. */
  pcRailPending: Record<string, PcRailPendingLedger>;
  /** hostId → sessionId → epoch ms this desktop first saw the pane `complete`. */
  pcRailCompleteSeenAt: Record<string, Record<string, number>>;

  /** Restore from session.json's `pcRail` field (any shape; never throws). */
  loadPcRailPersisted: (raw: unknown) => void;
  /** Select a computer. Unknown hosts are refused once the roster is known. */
  setActivePc: (pcId: PcId) => void;
  /** Remember the workspace last opened on a computer. Shadow ids are refused. */
  rememberPcWorkspace: (pcId: PcId, workspaceId: string) => void;
  setPcMuted: (hostId: string, muted: boolean) => void;
  applyPcRailFeedEvent: (event: PcRailFeedEvent, now?: number) => void;
  /** Apply one SSE frame. Returns true when a debounced approvals refetch is due. */
  applyPcRailAttention: (event: PcRailAttentionEvent, now?: number) => boolean;
  reconcilePcRailHostApprovals: (hostId: string, approvals: readonly RemoteApprovalSummary[], now?: number) => void;
  markPcWorkspaceSeen: (hostId: string, workspaceId: string, now?: number) => void;
  /**
   * Fold attached remote workspaces (the pre-rail model) into the rail: each
   * host's attached workspace becomes its last workspace, unless the rail
   * already remembers one. Reads only; the attached entries stay as they are.
   */
  migrateAttachedRemoteWorkspaces: () => void;
}

const STATUS_FOR_FAILURE: Record<PcRailFeedFailure, RemoteHostStatus> = {
  'unreachable': 'unreachable',
  'unavailable': 'unreachable',
  'auth-rejected': 'needs-repair',
  'insecure-transport': 'insecure',
};

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PC_RAIL_LIMITS.id && !isShadowWorkspaceId(value);
}

function emptyPersisted(): PcRailPersisted {
  return { ...DEFAULT_PC_RAIL_PERSISTED, lastWorkspaceByPc: {}, mutedPcs: [] };
}

/** Drop a host's memory-only state. */
function forgetHost(state: StoreState, hostId: string): void {
  delete state.pcRailFeeds[hostId];
  delete state.pcRailHostSeen[hostId];
  delete state.pcRailPending[hostId];
  delete state.pcRailCompleteSeenAt[hostId];
  delete state.pcRailHostStatus[hostId];
}

/**
 * The attached-workspace mapping, as a pure step so it can be tested on its
 * own: `lastWorkspaceByPc[hostId]` gets the attached workspace of that host
 * (the selected one first) when the rail has none for it yet.
 */
export function migrateAttachedToPcRail(
  persisted: PcRailPersisted,
  attached: ReadonlyArray<{ key: string; hostId: string; workspaceId: string; ephemeral?: boolean }>,
  activeRemoteKey: string | null,
): PcRailPersisted {
  const lastWorkspaceByPc = { ...persisted.lastWorkspaceByPc };
  let hosts = Object.keys(lastWorkspaceByPc).filter((id) => id !== LOCAL_PC_ID).length;
  const ordered = [...attached].sort((a, b) => Number(b.key === activeRemoteKey) - Number(a.key === activeRemoteKey));
  for (const w of ordered) {
    if (w.ephemeral || !validId(w.hostId) || w.hostId === LOCAL_PC_ID || !validId(w.workspaceId)) continue;
    if (Object.prototype.hasOwnProperty.call(lastWorkspaceByPc, w.hostId)) continue;
    if (hosts >= PC_RAIL_LIMITS.hosts) break;
    lastWorkspaceByPc[w.hostId] = w.workspaceId;
    hosts++;
  }
  return { ...persisted, lastWorkspaceByPc };
}

/** session.json's `pcRail` → state. Used by loadSession and loadPcRailPersisted. */
export function restorePcRail(state: Pick<StoreState, 'pcRail' | 'pcRailHosts' | 'pcRailHostsLoaded'>, raw: unknown): void {
  const parsed = parsePcRailPersisted(raw);
  state.pcRail = state.pcRailHostsLoaded
    ? prunePcRailPersisted(parsed, new Set(state.pcRailHosts.map((h) => h.id)))
    : parsed;
}

function sameRows(a: PcRailHostFeed, b: Pick<PcRailHostFeed, 'workspaces' | 'activeWorkspaceId'>): boolean {
  return a.activeWorkspaceId === b.activeWorkspaceId
    && JSON.stringify(a.workspaces) === JSON.stringify(b.workspaces);
}

export const createPcRailSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  PcRailSlice
> = (set, get) => ({
  pcRail: emptyPersisted(),
  pcRailHosts: [],
  pcRailHostsLoaded: false,
  pcRailHostStatus: {},
  pcRailFeeds: {},
  pcRailHostSeen: {},
  pcRailPending: {},
  pcRailCompleteSeenAt: {},

  loadPcRailPersisted: (raw) => set((state: StoreState) => restorePcRail(state, raw)),

  setActivePc: (pcId) => set((state: StoreState) => {
    if (pcId !== LOCAL_PC_ID) {
      if (!validId(pcId)) return;
      if (state.pcRailHostsLoaded && !state.pcRailHosts.some((h) => h.id === pcId)) return;
    }
    if (state.pcRail.activePcId !== pcId) state.pcRail.activePcId = pcId;
  }),

  rememberPcWorkspace: (pcId, workspaceId) => set((state: StoreState) => {
    if (!validId(pcId) || !validId(workspaceId)) return;
    const map = state.pcRail.lastWorkspaceByPc;
    if (map[pcId] === workspaceId) return;
    const hosts = Object.keys(map).filter((id) => id !== LOCAL_PC_ID && id !== pcId).length;
    if (pcId !== LOCAL_PC_ID && !(pcId in map) && hosts >= PC_RAIL_LIMITS.hosts) return;
    map[pcId] = workspaceId;
  }),

  setPcMuted: (hostId, muted) => set((state: StoreState) => {
    if (!validId(hostId) || hostId === LOCAL_PC_ID) return;
    const list = state.pcRail.mutedPcs;
    const at = list.indexOf(hostId);
    if (muted && at < 0 && list.length < PC_RAIL_LIMITS.hosts) list.push(hostId);
    else if (!muted && at >= 0) list.splice(at, 1);
  }),

  applyPcRailFeedEvent: (event, now = Date.now()) => set((state: StoreState) => {
    if (event.type === 'hosts') {
      const ids = new Set(event.hosts.map((h) => h.id));
      state.pcRailHosts = event.hosts;
      state.pcRailHostsLoaded = true;
      for (const id of Object.keys(state.pcRailFeeds)) if (!ids.has(id)) forgetHost(state, id);
      for (const id of Object.keys(state.pcRailHostStatus)) if (!ids.has(id)) forgetHost(state, id);
      const pruned = prunePcRailPersisted(state.pcRail, ids);
      if (JSON.stringify(pruned) !== JSON.stringify(state.pcRail)) state.pcRail = pruned;
      return;
    }
    const { hostId } = event;
    if (state.pcRailHostsLoaded && !state.pcRailHosts.some((h) => h.id === hostId)) return;
    const prev = state.pcRailFeeds[hostId];
    if (!event.ok) {
      state.pcRailHostStatus[hostId] = STATUS_FOR_FAILURE[event.reason];
      state.pcRailFeeds[hostId] = {
        workspaces: prev?.workspaces ?? [],
        ...(prev?.activeWorkspaceId ? { activeWorkspaceId: prev.activeWorkspaceId } : {}),
        fetchedAt: prev?.fetchedAt ?? null,
        failedTicks: (prev?.failedTicks ?? 0) + 1,
      };
      return;
    }
    if (state.pcRailHostStatus[hostId] !== 'reachable') state.pcRailHostStatus[hostId] = 'reachable';
    if (event.allowInput !== undefined) {
      const host = state.pcRailHosts.find((h) => h.id === hostId);
      if (host && host.allowInput !== event.allowInput) host.allowInput = event.allowInput;
    }
    const { workspaces, activeWorkspaceId } = event.response;
    if (prev && sameRows(prev, event.response)) {
      prev.fetchedAt = event.at;
      if (prev.failedTicks !== 0) prev.failedTicks = 0;
    } else {
      state.pcRailFeeds[hostId] = {
        workspaces,
        ...(activeWorkspaceId ? { activeWorkspaceId } : {}),
        fetchedAt: event.at,
        failedTicks: 0,
      };
    }

    // When each pane was first seen complete. On a host's first list, panes
    // already complete get 0: they finished before this desktop was looking.
    const firstList = !prev || prev.fetchedAt === null;
    const seenBefore = state.pcRailCompleteSeenAt[hostId] ?? {};
    const completeSeenAt: Record<string, number> = {};
    const live = new Set<string>();
    for (const ws of workspaces) {
      for (const p of ws.panes) {
        live.add(p.sessionId);
        if (p.agentStatus !== 'complete') continue;
        completeSeenAt[p.sessionId] = seenBefore[p.sessionId] ?? (firstList ? 0 : now);
      }
    }
    if (JSON.stringify(completeSeenAt) !== JSON.stringify(seenBefore)) state.pcRailCompleteSeenAt[hostId] = completeSeenAt;

    if (event.approvals) {
      state.pcRailPending[hostId] = reconcilePcRailApprovals(state.pcRailPending[hostId] ?? {}, event.approvals, now, live);
    }
  }),

  applyPcRailAttention: (event, now = Date.now()) => {
    const st = get();
    if (!st.pcRailHosts.some((h) => h.id === event.hostId)) return false;
    const ledger = st.pcRailPending[event.hostId] ?? {};
    const result = applyPcRailAttentionFrame(ledger, event.kind, event.data, now);
    if (result.ledger !== ledger) {
      set((state: StoreState) => { state.pcRailPending[event.hostId] = result.ledger; });
    }
    return result.refetch;
  },

  reconcilePcRailHostApprovals: (hostId, approvals, now = Date.now()) => set((state: StoreState) => {
    if (!state.pcRailHosts.some((h) => h.id === hostId)) return;
    const feed = state.pcRailFeeds[hostId];
    const live = feed?.fetchedAt != null
      ? new Set(feed.workspaces.flatMap((w) => w.panes.map((p) => p.sessionId)))
      : undefined;
    state.pcRailPending[hostId] = reconcilePcRailApprovals(state.pcRailPending[hostId] ?? {}, approvals, now, live);
  }),

  markPcWorkspaceSeen: (hostId, workspaceId, now = Date.now()) => set((state: StoreState) => {
    if (!validId(hostId) || !validId(workspaceId)) return;
    const seen = state.pcRailHostSeen[hostId] ?? (state.pcRailHostSeen[hostId] = {});
    seen[workspaceId] = now;
    const keys = Object.keys(seen);
    if (keys.length <= PC_RAIL_LIMITS.seenPerHost) return;
    keys.sort((a, b) => seen[a] - seen[b]);
    for (const k of keys.slice(0, keys.length - PC_RAIL_LIMITS.seenPerHost)) delete seen[k];
  }),

  migrateAttachedRemoteWorkspaces: () => set((state: StoreState) => {
    const next = migrateAttachedToPcRail(state.pcRail, state.remoteWorkspaces, state.activeRemoteKey);
    if (JSON.stringify(next.lastWorkspaceByPc) !== JSON.stringify(state.pcRail.lastWorkspaceByPc)) {
      state.pcRail.lastWorkspaceByPc = next.lastWorkspaceByPc;
    }
  }),
});
