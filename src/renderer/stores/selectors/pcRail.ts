/**
 * PC rail selectors — what the column (PR3) and the scoped sidebar and shadow
 * workspaces (PR4) read. Results are memoized on their inputs, so a poll tick
 * that changed nothing hands back the same array or object.
 */
import type { StoreState } from '../index';
import {
  LOCAL_PC_ID,
  comparePcRailRows,
  countPcRailAttention,
  isPcRailFeedStale,
  type PcId,
  type PcRailAttentionCounts,
  type PcRailAttentionPane,
  type PcRailHost,
  type PcRailHostFeed,
  type PcRailPersisted,
  type PcRailWorkspaceRow,
} from '../../../shared/pcRail';
import { remoteAttachmentKey } from '../../../shared/remoteHosts';

const NO_ATTENTION: PcRailAttentionCounts = Object.freeze({ needsYou: 0, finished: 0 });
const NO_ROWS: readonly PcRailWorkspaceRow[] = Object.freeze([]);

/** What session.json stores for the rail (the save path writes this as `pcRail`). */
export function selectPcRailPersisted(state: StoreState): PcRailPersisted {
  return state.pcRail;
}

export function selectActivePcId(state: StoreState): PcId {
  return state.pcRail.activePcId;
}

/** The column shows only while at least one web-paired host exists. */
export function selectPcRailVisible(state: StoreState): boolean {
  return state.pcRailHosts.length > 0;
}

export function selectPcRailFeed(state: StoreState, hostId: string): PcRailHostFeed | undefined {
  return state.pcRailFeeds[hostId];
}

/** Rows go muted once the host missed PC_RAIL_LIMITS.staleAfterFailedTicks ticks. */
export function selectPcRailFeedStale(state: StoreState, hostId: string): boolean {
  const feed = state.pcRailFeeds[hostId];
  return !!feed && isPcRailFeedStale(feed);
}

// Keyed on the rows array: a tick that only moves fetchedAt keeps it.
const sortedRowsCache = new WeakMap<readonly PcRailWorkspaceRow[], readonly PcRailWorkspaceRow[]>();

/** One host's workspace rows in that host's own sidebar order. */
export function selectPcRailRows(state: StoreState, hostId: string): readonly PcRailWorkspaceRow[] {
  const feed = state.pcRailFeeds[hostId];
  if (!feed) return NO_ROWS;
  let rows = sortedRowsCache.get(feed.workspaces);
  if (!rows) {
    rows = [...feed.workspaces].sort(comparePcRailRows);
    sortedRowsCache.set(feed.workspaces, rows);
  }
  return rows;
}

/**
 * The local label/color alias the user gave an attached remote workspace
 * (pre-rail model, remote-attachments.json). Read in place, never copied.
 */
export function selectPcRailRowAlias(
  state: StoreState,
  hostId: string,
  workspaceId: string,
): { label?: string; color?: string } | undefined {
  const key = remoteAttachmentKey(hostId, workspaceId);
  const entry = state.remoteWorkspaces.find((w) => w.key === key && !w.ephemeral);
  if (!entry || (!entry.label && !entry.color)) return undefined;
  return { ...(entry.label ? { label: entry.label } : {}), ...(entry.color ? { color: entry.color } : {}) };
}

function attentionPanes(feed: PcRailHostFeed | undefined): PcRailAttentionPane[] {
  if (!feed) return [];
  const panes: PcRailAttentionPane[] = [];
  for (const ws of feed.workspaces) {
    for (const p of ws.panes) {
      panes.push({
        sessionId: p.sessionId,
        workspaceId: ws.id,
        ...(p.agentName ? { agentName: p.agentName } : {}),
        ...(p.agentStatus ? { agentStatus: p.agentStatus } : {}),
      });
    }
  }
  return panes;
}

interface AttentionMemo {
  feed: PcRailHostFeed | undefined;
  pending: unknown;
  completeSeenAt: unknown;
  hostSeen: unknown;
  counts: PcRailAttentionCounts;
}
const attentionMemo = new Map<string, AttentionMemo>();

/** One host's badge numbers (needs-you, finished). */
export function selectPcAttention(state: StoreState, hostId: string): PcRailAttentionCounts {
  const feed = state.pcRailFeeds[hostId];
  const pending = state.pcRailPending[hostId];
  const completeSeenAt = state.pcRailCompleteSeenAt[hostId];
  const hostSeen = state.pcRailHostSeen[hostId];
  if (!feed && !pending) return NO_ATTENTION;
  const memo = attentionMemo.get(hostId);
  if (memo && memo.feed === feed && memo.pending === pending && memo.completeSeenAt === completeSeenAt && memo.hostSeen === hostSeen) {
    return memo.counts;
  }
  const counts = countPcRailAttention({
    panes: attentionPanes(feed),
    pending: pending ?? {},
    completeSeenAt: completeSeenAt ?? {},
    hostSeen: hostSeen ?? {},
  });
  const same = memo && memo.counts.needsYou === counts.needsYou && memo.counts.finished === counts.finished;
  const out = same ? memo.counts : counts;
  attentionMemo.set(hostId, { feed, pending, completeSeenAt, hostSeen, counts: out });
  return out;
}

let hostsMemo: { key: unknown[]; rows: PcRailHost[] } | null = null;

/** The column's host rows (this computer is not one of them), in main's order. */
export function selectPcRailHosts(state: StoreState): PcRailHost[] {
  const key: unknown[] = [state.pcRailHosts, state.pcRailHostStatus, state.pcRail.mutedPcs];
  const attention = state.pcRailHosts.map((h) => selectPcAttention(state, h.id));
  const fetched = state.pcRailHosts.map((h) => state.pcRailFeeds[h.id]?.fetchedAt ?? null);
  key.push(...attention, ...fetched);
  if (hostsMemo && hostsMemo.key.length === key.length && hostsMemo.key.every((v, i) => v === key[i])) {
    return hostsMemo.rows;
  }
  const muted = new Set(state.pcRail.mutedPcs);
  const rows = state.pcRailHosts.map((h, i): PcRailHost => ({
    id: h.id,
    label: h.label,
    kind: 'web-paired',
    // Main does not record how a host's credential was issued yet: no label.
    status: state.pcRailHostStatus[h.id] ?? 'reachable',
    ...(h.allowInput !== undefined ? { allowInput: h.allowInput } : {}),
    attention: attention[i],
    lastSeenAt: fetched[i],
    muted: muted.has(h.id),
  }));
  hostsMemo = { key, rows };
  return rows;
}

/** The workspace to reopen when a computer is selected, if any. */
export function selectLastWorkspaceForPc(state: StoreState, pcId: PcId): string | undefined {
  return state.pcRail.lastWorkspaceByPc[pcId];
}

/** True when the selected computer is this one. */
export function selectIsLocalPcActive(state: StoreState): boolean {
  return state.pcRail.activePcId === LOCAL_PC_ID;
}
