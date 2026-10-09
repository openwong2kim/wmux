/**
 * How a web-paired computer's attention counts are kept right.
 *
 * Two sources, with different jobs:
 *
 *   /api/events (SSE)  ── immediacy ──▶ applyPcRailAttentionFrame
 *                                       raises needs-you the moment an `act`
 *                                       frame lands, clears an approval on its
 *                                       settling frame, and asks for a refetch
 *                                       (debounced PC_RAIL_REFETCH_DEBOUNCE_MS)
 *
 *   GET /api/approvals ── truth ──────▶ reconcilePcRailApprovals
 *                                       on every poll tick and on every SSE
 *                                       (re)connect, REPLACES every approval
 *                                       entry and keeps the critical ones
 *
 * SSE alone is not enough: frames sent while the stream was down are not
 * replayed to this client. So an SSE approval entry is provisional until the
 * next list confirms or drops it.
 *
 * A `critical` frame names no approval and has no settling frame, so the list
 * cannot speak for it. Its entry stays until its pane leaves the host's list,
 * or until PC_RAIL_PENDING_TTL_MS passes without a newer frame.
 *
 * The ledger is bounded: at most PC_RAIL_APPROVAL_LIMITS.approvals entries
 * (the oldest goes first), and any entry not refreshed within
 * PC_RAIL_PENDING_TTL_MS expires.
 *
 * A single-key prompt answered from another device stays pending on the host
 * with `pressedAt` set until the pane moves on; it no longer needs the user,
 * so the list parse skips it and the SSE `press` frame drops it.
 *
 * `finished` has no host stamp: the host sends no completion time, so the
 * desktop records when it first saw each pane `complete` and compares that to
 * when the user last viewed the workspace (hostSeen).
 *
 * The host does not publish a pending question for remote panes yet, so a
 * turn that ends on a question counts as finished until it does.
 */

import type { RemoteAgentStatus } from '../remoteHosts';

/** One computer's badge numbers. */
export interface PcRailAttentionCounts {
  /** Panes waiting on the user: awaiting input, or holding a pending approval. */
  needsYou: number;
  /** Agent panes that completed since the user last viewed their workspace. */
  finished: number;
}

export const PC_RAIL_REFETCH_DEBOUNCE_MS = 1_000;

export const PC_RAIL_APPROVAL_LIMITS = { approvals: 256, id: 128 } as const;

/** An entry not confirmed or refreshed for this long is dropped. */
export const PC_RAIL_PENDING_TTL_MS = 10 * 60_000;

/** A pending approval as `GET /api/approvals` lists it (the fields the rail reads). */
export interface RemoteApprovalSummary {
  id: string;
  sessionId: string;
  workspaceId?: string;
}

export interface PcRailPendingEntry {
  sessionId: string;
  workspaceId?: string;
  /** Epoch ms the entry was last raised or confirmed. */
  at: number;
}

/**
 * What the rail believes is pending on one host, keyed so SSE and the list
 * agree on identity: `approval:<approvalId>` for an approval, and
 * `critical:<sessionId>` for a critical frame (which names no approval).
 */
export type PcRailPendingLedger = Readonly<Record<string, PcRailPendingEntry>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= PC_RAIL_APPROVAL_LIMITS.id ? value : undefined;
}

/**
 * The pending half of a `GET /api/approvals` body. Null when the body is not
 * that shape; entries that are not usable are dropped, as are prompts already
 * answered (`pressedAt`); duplicates collapse, and the count is capped.
 */
export function parseRemoteApprovalsList(body: unknown): RemoteApprovalSummary[] | null {
  if (!isRecord(body) || !Array.isArray(body.pending)) return null;
  const out: RemoteApprovalSummary[] = [];
  const seen = new Set<string>();
  for (const raw of body.pending) {
    if (out.length >= PC_RAIL_APPROVAL_LIMITS.approvals) break;
    if (!isRecord(raw) || raw.state !== 'pending' || raw.pressedAt !== undefined) continue;
    const id = boundedId(raw.id);
    const sessionId = boundedId(raw.sessionId);
    if (!id || !sessionId || seen.has(id)) continue;
    seen.add(id);
    const workspaceId = boundedId(raw.workspaceId);
    out.push({ id, sessionId, ...(workspaceId ? { workspaceId } : {}) });
  }
  return out;
}

function isFresh(entry: PcRailPendingEntry, now: number): boolean {
  return now - entry.at < PC_RAIL_PENDING_TTL_MS;
}

/**
 * Truth from the list. Every `approval:` entry is replaced by what the host
 * lists as pending. A `critical:` entry is kept while it is fresh and, when
 * `liveSessionIds` is given (the host's current panes), while its pane is
 * still listed.
 */
export function reconcilePcRailApprovals(
  ledger: PcRailPendingLedger,
  listed: readonly RemoteApprovalSummary[],
  now: number,
  liveSessionIds?: ReadonlySet<string>,
): PcRailPendingLedger {
  const next: Record<string, PcRailPendingEntry> = {};
  for (const [key, entry] of Object.entries(ledger)) {
    if (!key.startsWith('critical:') || !isFresh(entry, now)) continue;
    if (liveSessionIds && !liveSessionIds.has(entry.sessionId)) continue;
    next[key] = entry;
  }
  for (const a of listed.slice(0, PC_RAIL_APPROVAL_LIMITS.approvals)) {
    next[`approval:${a.id}`] = { sessionId: a.sessionId, ...(a.workspaceId ? { workspaceId: a.workspaceId } : {}), at: now };
  }
  return capLedger(next);
}

/** Drop the oldest entries until the ledger is within the cap. */
function capLedger(ledger: Record<string, PcRailPendingEntry>): Record<string, PcRailPendingEntry> {
  const keys = Object.keys(ledger);
  if (keys.length <= PC_RAIL_APPROVAL_LIMITS.approvals) return ledger;
  keys.sort((a, b) => ledger[a].at - ledger[b].at);
  for (const k of keys.slice(0, keys.length - PC_RAIL_APPROVAL_LIMITS.approvals)) delete ledger[k];
  return ledger;
}

/** The SSE kinds the rail reads. `notify` never moves a count. */
export type PcRailAttentionFrameKind = 'critical' | 'approval' | 'notify';

/** Approval phases after which the user has nothing left to answer. */
const CLEARING_PHASES: ReadonlySet<string> = new Set(['resolve', 'expire', 'supersede', 'press']);

/**
 * The tier values that mean "do not raise". A frame with no tier, or a tier
 * this desktop does not know, is treated as `act`: a missed alert costs more
 * than a spurious one, which the next list clears.
 */
const NON_ACT_TIERS: ReadonlySet<unknown> = new Set(['info']);

/**
 * Immediacy from one SSE frame (`data` is the frame body: the payload plus the
 * envelope's `tier`). Returns the next ledger and whether a list refetch
 * should be scheduled.
 *
 *   critical            raise, unless its tier is a known non-act tier
 *   approval, clearing  (resolve / expire / supersede / press) remove
 *   approval, act tier  raise
 *   approval, create    raise when the tier is missing or unknown
 *
 * Anything else leaves the ledger as is. A frame that changes nothing (a
 * repeat of a held entry, or a clear of one not held) returns the same ledger
 * object, so it costs no copy.
 */
export function applyPcRailAttentionFrame(
  ledger: PcRailPendingLedger,
  kind: PcRailAttentionFrameKind,
  data: unknown,
  now: number,
): { ledger: PcRailPendingLedger; refetch: boolean } {
  const unchanged = { ledger, refetch: false };
  if (kind === 'notify' || !isRecord(data)) return unchanged;
  const sessionId = boundedId(data.sessionId);
  if (!sessionId) return unchanged;
  const workspaceId = boundedId(data.workspaceId);
  const entry: PcRailPendingEntry = { sessionId, ...(workspaceId ? { workspaceId } : {}), at: now };
  const raise = (key: string): { ledger: PcRailPendingLedger; refetch: boolean } => {
    const held = ledger[key];
    // A repeat within half the TTL changes nothing; a later one renews the entry.
    if (held && now - held.at < PC_RAIL_PENDING_TTL_MS / 2 && held.sessionId === sessionId) return unchanged;
    const next: Record<string, PcRailPendingEntry> = {};
    for (const [k, e] of Object.entries(ledger)) if (isFresh(e, now)) next[k] = e;
    next[key] = entry;
    return { ledger: capLedger(next), refetch: true };
  };
  const nonAct = NON_ACT_TIERS.has(data.tier);
  if (kind === 'critical') return nonAct ? unchanged : raise(`critical:${sessionId}`);
  const approvalId = boundedId(data.approvalId);
  if (!approvalId) return unchanged;
  const key = `approval:${approvalId}`;
  const phase = typeof data.phase === 'string' ? data.phase : undefined;
  if (phase !== undefined && CLEARING_PHASES.has(phase)) {
    if (!(key in ledger)) return unchanged;
    const next = { ...ledger };
    delete next[key];
    return { ledger: next, refetch: true };
  }
  if (data.tier === 'act' || (!nonAct && phase === 'create')) return raise(key);
  return unchanged;
}

/** The pane facts the counts read, per listed pane. */
export interface PcRailAttentionPane {
  sessionId: string;
  workspaceId: string;
  /** Only panes that name an agent count, as for an attached remote row today. */
  agentName?: string;
  agentStatus?: RemoteAgentStatus;
}

export interface PcRailAttentionInput {
  panes: readonly PcRailAttentionPane[];
  pending: PcRailPendingLedger;
  /** sessionId → epoch ms this desktop first saw the pane `complete` (reset when it leaves `complete`). */
  completeSeenAt: Readonly<Record<string, number>>;
  /** remote workspaceId → epoch ms the user last viewed it on this desktop. */
  hostSeen: Readonly<Record<string, number>>;
}

/**
 * One computer's counts. needs-you counts distinct panes (a pane both awaiting
 * input and holding an approval counts once); pending entries for panes the
 * list no longer carries still count, since the list is the newer truth only
 * for approvals. finished counts agent panes that completed after their
 * workspace was last viewed and that do not also need the user.
 */
export function countPcRailAttention(input: PcRailAttentionInput): PcRailAttentionCounts {
  const needs = new Set<string>();
  for (const p of input.panes) {
    if (p.agentName && p.agentStatus === 'awaiting_input') needs.add(p.sessionId);
  }
  for (const entry of Object.values(input.pending)) needs.add(entry.sessionId);
  let finished = 0;
  for (const p of input.panes) {
    if (!p.agentName || p.agentStatus !== 'complete' || needs.has(p.sessionId)) continue;
    const at = input.completeSeenAt[p.sessionId];
    if (at === undefined) continue;
    if (at > (input.hostSeen[p.workspaceId] ?? 0)) finished++;
  }
  return { needsYou: needs.size, finished };
}
