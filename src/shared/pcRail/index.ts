/**
 * PC rail: the shared contract.
 *
 * A column left of the page rail lists this computer and every web-paired
 * computer (a RemoteHost). Picking one scopes the Workspaces page to it. This
 * module only defines the shapes and the pure rules the store (PR2), the
 * column (PR3) and shadow workspaces (PR4) build on; nothing runs it yet.
 *
 *   main (poll tick, SSE per host) ──IPC──▶ renderer pcRail slice ──▶ PC column
 *        PC_RAIL_IPC                        PcRailSelection (persisted)
 *                                           PcRailEphemeral (memory only)
 *
 * Persistence: only activePcId, lastWorkspaceByPc and mutedPcs reach
 * session.json. Feeds, seen stamps and shadow workspaces are memory only;
 * a shadow is a projection of the host and is rebuilt from its layout.
 */

import type { RemoteHostStatus } from '../remoteHosts';
import type { PcRailAttentionCounts, PcRailAttentionFrameKind, RemoteApprovalSummary } from './attention';
import type { PcRailWorkspaceRow } from './workspaceRow';
import { isShadowWorkspaceId } from './shadowId';

export * from './attention';
export * from './shadowId';
export * from './shortcuts';
export * from './workspaceRow';

/** The rail entry for the computer wmux runs on. Never a RemoteHost id (those are uuids). */
export const LOCAL_PC_ID = 'local';

/** `LOCAL_PC_ID` or a RemoteHost id. */
export type PcId = string;

export const PC_RAIL_LIMITS = {
  /** Remembered hosts in lastWorkspaceByPc / mutedPcs. */
  hosts: 64,
  /** Any id held in the persisted state. */
  id: 128,
  /** A ticks-without-answer count after which a host's rows show as stale. */
  staleAfterFailedTicks: 3,
  /** Remote workspaces with a hostSeen stamp, per host. */
  seenPerHost: 500,
} as const;

/** How the desktop holds a host's credential. Recorded when the host is added. */
export type PcRailTokenKind = 'device' | 'operator';

/**
 * One computer in the column. Only web-paired hosts get a row; A2A-only peers
 * stay on the Remote page, and the two pairings are never merged.
 */
export interface PcRailHost {
  /** RemoteHost.id. */
  id: string;
  label: string;
  kind: 'web-paired';
  /**
   * `operator`: added with the host's own web link, which is not a paired
   * device on that computer; the UI labels it and suggests pairing again.
   * Absent for hosts added before this was recorded: show neither label.
   */
  tokenKind?: PcRailTokenKind;
  /** From REMOTE_HOSTS_STATUS. `unreachable` renders as Offline, `needs-repair` as Pair again. */
  status: RemoteHostStatus;
  /** False when the host refuses typing (view only). Absent until probed. */
  allowInput?: boolean;
  attention: PcRailAttentionCounts;
  /** Epoch ms of the last successful workspace list, or null if none yet. */
  lastSeenAt: number | null;
  /** Notifications from this computer are muted (its badge still counts). */
  muted: boolean;
}

/** True for the statuses the column draws as online. */
export function isPcRailHostOnline(status: RemoteHostStatus): boolean {
  return status === 'connected' || status === 'reachable';
}

/** What the rail keeps across restarts (optional fields in session.json). */
export interface PcRailPersisted {
  activePcId: PcId;
  /**
   * pcId → the workspace last opened there: a local workspace id for
   * LOCAL_PC_ID, a remote workspace id for a host. Never a shadow id.
   */
  lastWorkspaceByPc: Record<PcId, string>;
  /** Hosts whose notifications are muted. */
  mutedPcs: string[];
}

export const DEFAULT_PC_RAIL_PERSISTED: PcRailPersisted = {
  activePcId: LOCAL_PC_ID,
  lastWorkspaceByPc: {},
  mutedPcs: [],
};

/** One host's workspace list as the renderer caches it. */
export interface PcRailHostFeed {
  workspaces: PcRailWorkspaceRow[];
  activeWorkspaceId?: string;
  /** Epoch ms of the last successful list, or null before the first. */
  fetchedAt: number | null;
  /** Ticks in a row with no usable answer; reset by a successful list. */
  failedTicks: number;
}

/** Rail state that never leaves memory. */
export interface PcRailEphemeral {
  hostFeeds: Record<string, PcRailHostFeed>;
  /** hostId → remote workspace id → epoch ms the user last viewed it. */
  hostSeen: Record<string, Record<string, number>>;
}

/** Rows go muted ("updated 2 min ago") once a host has missed this many ticks. */
export function isPcRailFeedStale(feed: Pick<PcRailHostFeed, 'failedTicks'>): boolean {
  return feed.failedTicks >= PC_RAIL_LIMITS.staleAfterFailedTicks;
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function persistedId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > PC_RAIL_LIMITS.id) return undefined;
  if (RESERVED_KEYS.has(value) || isShadowWorkspaceId(value)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * session.json → rail state. Never throws; anything unusable falls back to the
 * default. Shadow ids are refused wherever an id is read, so a shadow can
 * never be restored from disk.
 */
export function parsePcRailPersisted(value: unknown): PcRailPersisted {
  if (!isRecord(value)) return { ...DEFAULT_PC_RAIL_PERSISTED, lastWorkspaceByPc: {}, mutedPcs: [] };
  const activePcId = persistedId(value.activePcId) ?? LOCAL_PC_ID;
  const lastWorkspaceByPc: Record<PcId, string> = {};
  if (isRecord(value.lastWorkspaceByPc)) {
    let kept = 0;
    for (const [pcId, wsId] of Object.entries(value.lastWorkspaceByPc)) {
      if (kept >= PC_RAIL_LIMITS.hosts) break;
      const pc = persistedId(pcId);
      const ws = persistedId(wsId);
      if (!pc || !ws) continue;
      lastWorkspaceByPc[pc] = ws;
      kept++;
    }
  }
  const mutedPcs: string[] = [];
  if (Array.isArray(value.mutedPcs)) {
    for (const raw of value.mutedPcs) {
      if (mutedPcs.length >= PC_RAIL_LIMITS.hosts) break;
      const id = persistedId(raw);
      if (id && id !== LOCAL_PC_ID && !mutedPcs.includes(id)) mutedPcs.push(id);
    }
  }
  return { activePcId, lastWorkspaceByPc, mutedPcs };
}

/**
 * Drop state for hosts that are no longer paired. A removed active host
 * falls back to this computer.
 */
export function prunePcRailPersisted(state: PcRailPersisted, hostIds: ReadonlySet<string>): PcRailPersisted {
  const known = (id: string): boolean => id === LOCAL_PC_ID || hostIds.has(id);
  const lastWorkspaceByPc: Record<PcId, string> = {};
  for (const [pcId, wsId] of Object.entries(state.lastWorkspaceByPc)) {
    if (known(pcId)) lastWorkspaceByPc[pcId] = wsId;
  }
  return {
    activePcId: known(state.activePcId) ? state.activePcId : LOCAL_PC_ID,
    lastWorkspaceByPc,
    mutedPcs: state.mutedPcs.filter((id) => hostIds.has(id)),
  };
}

/**
 * IPC channels PR2 implements. Listed here so the main and renderer halves can
 * be built apart; PR2 moves them into the IPC table in constants.ts.
 *
 * The workspace list itself keeps REMOTE_WORKSPACES_LIST, with the widened row
 * (PcRailWorkspaceRow) and the request below.
 */
export const PC_RAIL_IPC = {
  /** renderer → main (send). The column is mounted: poll every host and hold an SSE per host. Refcounted per WebContents. */
  SUBSCRIBE: 'pcRail:subscribe',
  /** renderer → main (send). Releases one SUBSCRIBE. */
  UNSUBSCRIBE: 'pcRail:unsubscribe',
  /** renderer → main (invoke). `GET /api/approvals` on one host: PcRailApprovalsRequest → PcRailApprovalsResult. */
  APPROVALS_LIST: 'pcRail:approvals:list',
  /** main → renderer (push). One SSE attention frame: PcRailAttentionEvent. */
  ATTENTION_EVENT: 'pcRail:attention-event',
  /** main → renderer (push). A host's SSE opened, reopened or closed: PcRailStreamEvent. Open/reopen means reconcile. */
  STREAM_EVENT: 'pcRail:stream-event',
  /** renderer → main (invoke). The full muted set, so main can hold back that host's toasts: PcRailMutesRequest → void. */
  MUTES_SET: 'pcRail:mutes:set',
} as const;

/** REMOTE_WORKSPACES_LIST request as the rail sends it. */
export interface PcRailWorkspacesListRequest {
  hostId: string;
  /** Re-probe `/api/config` with this list. The rail asks on every 6th tick only. */
  probeConfig?: boolean;
}

/** Ticks between `/api/config` re-probes. */
export const PC_RAIL_CONFIG_PROBE_EVERY_TICKS = 6;

export interface PcRailApprovalsRequest {
  hostId: string;
}

export type PcRailApprovalsResult =
  | { ok: true; approvals: RemoteApprovalSummary[] }
  | { ok: false; reason: 'unreachable' | 'auth-rejected' | 'insecure-transport' | 'unavailable' };

export interface PcRailAttentionEvent {
  hostId: string;
  kind: PcRailAttentionFrameKind;
  /** The frame body, untouched; applyPcRailAttentionFrame validates it. */
  data: unknown;
}

export interface PcRailStreamEvent {
  hostId: string;
  state: 'open' | 'reopen' | 'closed';
}

export interface PcRailMutesRequest {
  hostIds: string[];
}
