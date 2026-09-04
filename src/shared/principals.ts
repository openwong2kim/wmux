// ─── Principals (R2) ──────────────────────────────────────────────────
// Schema that unifies every actor (human / pane agent / external) into a
// single address space. Channel membership, mentions, and a2a recipient
// labels are all built on top of it.
//
// Trust boundary (architecture doc §6, #113): principal id and memberId are
// display/routing labels, not authz. Authz stays on the existing
// verifiedWorkspaceId scheme.
//
// Storage: daemon `principals.json` (PrincipalStateWriter). The renderer's
// agent detection (surfaceAgent) is the source of upserts, and the daemon
// downgrades liveness to stale on session death. On daemon restart every
// pane-agent is backfilled to stale — the daemon cannot prove a pane is
// alive, so only a renderer re-registration brings it back to live (this
// structurally blocks the stale→live mis-sync bug direction).
//
// Design source of truth: plans/agent-collaboration-architecture-2026-07-03.md §3.1

/** external is reserved for R4 (external agents) — R2 only creates human/pane-agent. */
export type PrincipalKind = 'human' | 'pane-agent' | 'external';

export type PrincipalLiveness = 'live' | 'stale';

/** Wake method per recipient kind (architecture §4 Reachability adapters). */
export type PrincipalReachability =
  | 'gui'
  | 'renderer-hook'
  | 'pty-nudge'
  | 'poll-only';

/** The single principal id representing this GUI's human user. */
export const HUMAN_SELF_PRINCIPAL_ID = 'human:me';

/**
 * Stable coordinate id for a pane-agent principal. display (auto name) drifts
 * when the workspace is reordered, but this id is immutable while the pane
 * is alive.
 */
export function panePrincipalId(workspaceId: string, paneId: string): string {
  return `pane:${workspaceId}/${paneId}`;
}

/**
 * Inverse of {@link panePrincipalId}. Returns `null` for anything that is not a
 * pane principal (`human:me`, `ext:*`, or a malformed id) — callers that need
 * the coordinate must handle "this row does not name a pane".
 *
 * Split at the LAST `/` so a workspace id containing one still yields the pane
 * id, which is the segment the format actually pins.
 */
export function parsePanePrincipalId(
  principalId: string,
): { workspaceId: string; paneId: string } | null {
  if (!principalId.startsWith('pane:')) return null;
  const body = principalId.slice('pane:'.length);
  const sep = body.lastIndexOf('/');
  if (sep <= 0 || sep === body.length - 1) return null;
  return { workspaceId: body.slice(0, sep), paneId: body.slice(sep + 1) };
}

export interface PrincipalRecord {
  /** 'human:me' | `pane:${workspaceId}/${paneId}` | `ext:${name}`(R4) */
  id: string;
  kind: PrincipalKind;
  /** 'Me' or computePaneAutoName result (e.g. "w8-1(claude)"). Display only. */
  display: string;
  reachability: PrincipalReachability;
  liveness: PrincipalLiveness;
  /**
   * Company-mode reserved field — always null/absent in v0. The moment a
   * supervisor's principal id lands here the delegation/reporting tree is
   * complete (enabling it is a separate decision after R6).
   */
  reportsTo?: string | null;
  /** pane-agent-only coordinate. */
  workspaceId?: string;
  paneId?: string;
  /** Current pty (daemon session id). Refreshed via upsert on agent restart. */
  ptyId?: string;
  /** Channel memberId = the auto name, same as the mention token. */
  memberId?: string;
  /** Detected agent slug such as 'claude'. */
  agentSlug?: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. Refreshed on every upsert. */
  lastSeenAt: number;
}

export interface PrincipalState {
  /** Schema version. Additive extensions do not bump it (channels.ts convention). */
  version: number;
  principals: PrincipalRecord[];
}

export const EMPTY_PRINCIPAL_STATE: PrincipalState = {
  version: 1,
  principals: [],
};

/**
 * Retention window for stale pane-agent records. Stale records whose
 * lastSeenAt is older than this are cleaned up on load — same philosophy as
 * the channel empty-channel TTL (7d): keeps dead coordinates from piling up
 * in the registry indefinitely.
 */
export const PRINCIPAL_STALE_TTL_HOURS_DEFAULT = 7 * 24;

/**
 * Shape validation for `a2a.principal.upsert` input. This is a renderer-only
 * path so the trust anchor is the process boundary, but by convention the
 * daemon still defensively checks the shape.
 * (createdAt/lastSeenAt/liveness are service-managed, so they are not in the input.)
 */
export function isPrincipalUpsertInput(v: unknown): v is Omit<
  PrincipalRecord,
  'createdAt' | 'lastSeenAt' | 'liveness'
> {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || p['id'].length === 0) return false;
  if (p['kind'] !== 'human' && p['kind'] !== 'pane-agent' && p['kind'] !== 'external') {
    return false;
  }
  if (typeof p['display'] !== 'string' || p['display'].length === 0) return false;
  if (
    p['reachability'] !== 'gui' &&
    p['reachability'] !== 'renderer-hook' &&
    p['reachability'] !== 'pty-nudge' &&
    p['reachability'] !== 'poll-only'
  ) {
    return false;
  }
  for (const key of ['workspaceId', 'paneId', 'ptyId', 'memberId', 'agentSlug'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') return false;
  }
  if (p['reportsTo'] !== undefined && p['reportsTo'] !== null && typeof p['reportsTo'] !== 'string') {
    return false;
  }
  return true;
}
