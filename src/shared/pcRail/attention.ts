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
 *                                       (re)connect, REPLACES the whole set
 *
 * SSE alone is not enough: frames sent while the stream was down are not
 * replayed to this client, and a `critical` frame has no settling frame at all.
 * So an SSE entry is provisional until the next list confirms or drops it.
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

/** A pending approval as `GET /api/approvals` lists it (the fields the rail reads). */
export interface RemoteApprovalSummary {
  id: string;
  sessionId: string;
  workspaceId?: string;
}

/**
 * What the rail believes is pending on one host, keyed so SSE and the list
 * agree on identity: `approval:<approvalId>` for an approval, and
 * `critical:<sessionId>` for a critical frame (which names no approval).
 */
export type PcRailPendingLedger = Readonly<Record<string, { sessionId: string; workspaceId?: string }>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= PC_RAIL_APPROVAL_LIMITS.id ? value : undefined;
}

/**
 * The pending half of a `GET /api/approvals` body. Null when the body is not
 * that shape; entries that are not usable are dropped, duplicates collapse,
 * and the count is capped.
 */
export function parseRemoteApprovalsList(body: unknown): RemoteApprovalSummary[] | null {
  if (!isRecord(body) || !Array.isArray(body.pending)) return null;
  const out: RemoteApprovalSummary[] = [];
  const seen = new Set<string>();
  for (const raw of body.pending) {
    if (out.length >= PC_RAIL_APPROVAL_LIMITS.approvals) break;
    if (!isRecord(raw) || raw.state !== 'pending') continue;
    const id = boundedId(raw.id);
    const sessionId = boundedId(raw.sessionId);
    if (!id || !sessionId || seen.has(id)) continue;
    seen.add(id);
    const workspaceId = boundedId(raw.workspaceId);
    out.push({ id, sessionId, ...(workspaceId ? { workspaceId } : {}) });
  }
  return out;
}

/** Truth from the list: the ledger becomes exactly what the host lists as pending. */
export function reconcilePcRailApprovals(listed: readonly RemoteApprovalSummary[]): PcRailPendingLedger {
  const next: Record<string, { sessionId: string; workspaceId?: string }> = {};
  for (const a of listed) {
    next[`approval:${a.id}`] = { sessionId: a.sessionId, ...(a.workspaceId ? { workspaceId: a.workspaceId } : {}) };
  }
  return next;
}

/** The SSE kinds the rail reads. `notify` never moves a count. */
export type PcRailAttentionFrameKind = 'critical' | 'approval' | 'notify';

const SETTLING_PHASES: ReadonlySet<string> = new Set(['resolve', 'expire', 'supersede']);

/**
 * Immediacy from one SSE frame (`data` is the frame body: the payload plus the
 * envelope's `tier`). Returns the next ledger and whether a list refetch
 * should be scheduled. An `act` approval or critical frame adds an entry; an
 * approval's settling frame removes it. Anything else leaves the ledger as is.
 */
export function applyPcRailAttentionFrame(
  ledger: PcRailPendingLedger,
  kind: PcRailAttentionFrameKind,
  data: unknown,
): { ledger: PcRailPendingLedger; refetch: boolean } {
  if (kind === 'notify' || !isRecord(data)) return { ledger, refetch: false };
  const sessionId = boundedId(data.sessionId);
  if (!sessionId) return { ledger, refetch: false };
  const workspaceId = boundedId(data.workspaceId);
  const entry = { sessionId, ...(workspaceId ? { workspaceId } : {}) };
  if (kind === 'critical') {
    if (data.tier !== 'act') return { ledger, refetch: false };
    return { ledger: { ...ledger, [`critical:${sessionId}`]: entry }, refetch: true };
  }
  const approvalId = boundedId(data.approvalId);
  if (!approvalId) return { ledger, refetch: false };
  const key = `approval:${approvalId}`;
  if (data.tier === 'act') return { ledger: { ...ledger, [key]: entry }, refetch: true };
  if (typeof data.phase === 'string' && SETTLING_PHASES.has(data.phase) && key in ledger) {
    const next = { ...ledger };
    delete next[key];
    return { ledger: next, refetch: true };
  }
  return { ledger, refetch: false };
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
