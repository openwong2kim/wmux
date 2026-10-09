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
  type PcId,
  type PcRailAttentionEvent,
  type PcRailHostFeed,
  type PcRailPendingLedger,
  type PcRailPersisted,
  type RemoteApprovalSummary,
} from '../../../shared/pcRail';
import type { PcRailFeedEvent, PcRailFeedFailure, PcRailHostInfo } from '../../../main/remote/pcRailWire';
import { applyPcRailApprovalsSnapshot, dropGonePcRailCritical, purgeExpiredPcRailEntries } from './pcRailLedger';

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
  /** hostId → how fresh its approvals snapshot is (see PcRailLedgerMeta). */
  pcRailLedgerMeta: Record<string, PcRailLedgerMeta>;

  /** Restore from session.json's `pcRail` field (any shape; never throws). */
  loadPcRailPersisted: (raw: unknown) => void;
  /** Select a computer. Unknown hosts are refused once the roster is known. */
  setActivePc: (pcId: PcId) => void;
  /** Remember the workspace last opened on a computer. Shadow ids are refused. */
  rememberPcWorkspace: (pcId: PcId, workspaceId: string) => void;
  setPcMuted: (hostId: string, muted: boolean) => void;
  /** Apply one main push. Returns true when the tick's approvals lost a race and a refetch is due. */
  applyPcRailFeedEvent: (event: PcRailFeedEvent, now?: number) => boolean;
  /** Apply one SSE frame. Returns true when a debounced approvals refetch is due. */
  applyPcRailAttention: (event: PcRailAttentionEvent, now?: number) => boolean;
  /**
   * Apply an approvals snapshot whose request started at `requestedAt`.
   * 'superseded': a newer snapshot already landed, nothing to do.
   * 'raced': an SSE frame moved the ledger after the request started; refetch.
   */
  reconcilePcRailHostApprovals: (
    hostId: string,
    approvals: readonly RemoteApprovalSummary[],
    requestedAt: number,
    now?: number,
  ) => PcRailApprovalsApply;
  markPcWorkspaceSeen: (hostId: string, workspaceId: string, now?: number) => void;
  /**
   * Fold attached remote workspaces (the pre-rail model) into the rail: each
   * host's attached workspace becomes its last workspace, unless the rail
   * already remembers one. Reads only; the attached entries stay as they are.
   */
  migrateAttachedRemoteWorkspaces: () => void;
}

export interface PcRailLedgerMeta {
  /** Request start of the last approvals snapshot applied. Older answers are dropped. */
  approvalsFrom: number;
  /** When an SSE frame last changed this host's ledger. */
  sseChangedAt: number;
  /** Why the last tick's approvals read failed; absent once one succeeds. */
  approvalsError?: PcRailFeedFailure;
}

export type PcRailApprovalsApply = 'applied' | 'superseded' | 'raced';

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const STATUS_FOR_FAILURE: Record<PcRailFeedFailure, RemoteHostStatus> = {
  'unreachable': 'unreachable',
  'unavailable': 'unreachable',
  'auth-rejected': 'needs-repair',
  'insecure-transport': 'insecure',
};

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PC_RAIL_LIMITS.id
    && !RESERVED_KEYS.has(value)
    && !isShadowWorkspaceId(value);
}

function emptyPersisted(): PcRailPersisted {
  return { ...DEFAULT_PC_RAIL_PERSISTED, lastWorkspaceByPc: {}, mutedPcs: [] };
}

/** Every memory-only map keyed by host id. */
const PER_HOST_MAPS = [
  'pcRailFeeds',
  'pcRailHostSeen',
  'pcRailPending',
  'pcRailCompleteSeenAt',
  'pcRailHostStatus',
  'pcRailLedgerMeta',
] as const satisfies ReadonlyArray<keyof PcRailSlice>;

/** Drop memory-only state for every host not in `keep`. */
function forgetHostsExcept(state: StoreState, keep: ReadonlySet<string>): void {
  for (const map of PER_HOST_MAPS) {
    const record = state[map] as Record<string, unknown>;
    for (const id of Object.keys(record)) if (!keep.has(id)) delete record[id];
  }
}

/**
 * Apply an approvals snapshot under the request-ordering rules. Mutates the
 * draft; returns what happened.
 */
function applyApprovals(
  state: StoreState,
  hostId: string,
  approvals: readonly RemoteApprovalSummary[],
  requestedAt: number,
  now: number,
): PcRailApprovalsApply {
  const meta = state.pcRailLedgerMeta[hostId] ?? (state.pcRailLedgerMeta[hostId] = { approvalsFrom: 0, sseChangedAt: 0 });
  if (requestedAt < meta.approvalsFrom) return 'superseded';
  if (requestedAt < meta.sseChangedAt) return 'raced';
  meta.approvalsFrom = requestedAt;
  if (meta.approvalsError !== undefined) delete meta.approvalsError;
  const ledger = state.pcRailPending[hostId] ?? {};
  state.pcRailPending[hostId] = applyPcRailApprovalsSnapshot(ledger, approvals, requestedAt, now);
  return 'applied';
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
  pcRailLedgerMeta: {},

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

  applyPcRailFeedEvent: (event, now = Date.now()) => {
    let refetch = false;
    set((state: StoreState) => {
      if (event.type === 'hosts') {
        const ids = new Set(event.hosts.map((h) => h.id));
        state.pcRailHosts = event.hosts;
        state.pcRailHostsLoaded = true;
        forgetHostsExcept(state, ids);
        const pruned = prunePcRailPersisted(state.pcRail, ids);
        if (JSON.stringify(pruned) !== JSON.stringify(state.pcRail)) state.pcRail = pruned;
        return;
      }
      const { hostId } = event;
      if (state.pcRailHostsLoaded && !state.pcRailHosts.some((h) => h.id === hostId)) return;

      // Expired entries go on every tick, answered or not, so an offline
      // host's badge cannot hold a count forever.
      const held = state.pcRailPending[hostId];
      if (held) {
        const purged = purgeExpiredPcRailEntries(held, now);
        if (purged !== held) state.pcRailPending[hostId] = purged;
      }

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

      const ledger = state.pcRailPending[hostId];
      if (ledger) {
        const kept = dropGonePcRailCritical(ledger, live, event.listRequestedAt);
        if (kept !== ledger) state.pcRailPending[hostId] = kept;
      }
      if (event.approvals && event.approvalsRequestedAt !== undefined) {
        refetch = applyApprovals(state, hostId, event.approvals, event.approvalsRequestedAt, now) === 'raced';
      } else if (event.approvalsError) {
        const meta = state.pcRailLedgerMeta[hostId] ?? (state.pcRailLedgerMeta[hostId] = { approvalsFrom: 0, sseChangedAt: 0 });
        if (meta.approvalsError !== event.approvalsError) meta.approvalsError = event.approvalsError;
      }
    });
    return refetch;
  },

  applyPcRailAttention: (event, now = Date.now()) => {
    const st = get();
    if (!st.pcRailHosts.some((h) => h.id === event.hostId)) return false;
    const ledger = st.pcRailPending[event.hostId] ?? {};
    const result = applyPcRailAttentionFrame(ledger, event.kind, event.data, now);
    if (result.ledger !== ledger) {
      set((state: StoreState) => {
        state.pcRailPending[event.hostId] = result.ledger;
        const meta = state.pcRailLedgerMeta[event.hostId] ?? (state.pcRailLedgerMeta[event.hostId] = { approvalsFrom: 0, sseChangedAt: 0 });
        meta.sseChangedAt = Math.max(meta.sseChangedAt, now);
      });
    }
    return result.refetch;
  },

  reconcilePcRailHostApprovals: (hostId, approvals, requestedAt, now = Date.now()) => {
    let result: PcRailApprovalsApply = 'superseded';
    set((state: StoreState) => {
      if (!state.pcRailHosts.some((h) => h.id === hostId)) return;
      result = applyApprovals(state, hostId, approvals, requestedAt, now);
    });
    return result;
  },

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
