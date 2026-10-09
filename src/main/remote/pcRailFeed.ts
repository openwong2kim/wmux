// PC rail: the one-shot reads the rail makes against a web-paired host.
//
//   GET /api/workspaces  → PcRailWorkspacesResponse: the attach path's rows
//                          (normalizeWorkspaces) plus the sidebar extras,
//                          the host's focus and each row's layout
//   GET /api/approvals   → the pending half, through parseRemoteApprovalsList
//   GET /api/config      → allowInput, re-probed every few ticks
//
// Every body is read through readBoundedJson and every row is bounded by
// REMOTE_LIMITS before it leaves this module.

import type { RemoteHost } from '../../shared/remoteHosts';
import { isCredentialSafeOriginString } from '../../shared/remotePairInput';
import { REMOTE_LIMITS, parseRemoteLayout, remoteId } from '../../shared/remoteLimits';
import type { PhoneWorkspaceLayout } from '../../shared/phoneFleetSidebar';
import {
  parsePcRailWorkspaceExtras,
  parseRemoteApprovalsList,
  type PcRailApprovalsResult,
  type PcRailWorkspaceRow,
  type PcRailWorkspacesResponse,
} from '../../shared/pcRail';
import { normalizeWorkspaces } from './RemoteHostClient';
import { readBoundedJson } from './readBoundedJson';
import type { PcRailFeedFailure } from './pcRailWire';

const REQUEST_TIMEOUT_MS = 10_000;

/** `/api/approvals`: up to PC_RAIL_APPROVAL_LIMITS.approvals pending entries plus the resolved tail. */
const APPROVALS_BODY_BYTES = 1024 * 1024;

export type PcRailWorkspacesFetch =
  | { ok: true; response: PcRailWorkspacesResponse }
  | { ok: false; reason: PcRailFeedFailure };

function discard(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

async function getJson(
  host: RemoteHost,
  path: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: PcRailFeedFailure }> {
  // Never send the token to another machine over plain http.
  if (!isCredentialSafeOriginString(host.origin)) return { ok: false, reason: 'insecure-transport' };
  let res: Response;
  try {
    res = await fetchImpl(`${host.origin}${path}`, {
      headers: { Authorization: `Bearer ${host.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status === 401 || res.status === 403) {
    discard(res);
    return { ok: false, reason: 'auth-rejected' };
  }
  if (!res.ok) {
    discard(res);
    return { ok: false, reason: 'unavailable' };
  }
  try {
    return { ok: true, body: await readBoundedJson(res, maxBytes) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A row's split tree under the layout bounds, plus `unplaced` limited to the
 * row's own sessions. Undefined when the host sent none or it fails a bound.
 */
function parseRowLayout(raw: unknown, listed: ReadonlySet<string>): PhoneWorkspaceLayout | undefined {
  const layout = parseRemoteLayout(raw);
  if (!layout) return undefined;
  const unplaced: string[] = [];
  const rawUnplaced = isRecord(raw) && Array.isArray(raw.unplaced) ? raw.unplaced : [];
  for (const value of rawUnplaced) {
    if (unplaced.length >= listed.size) break;
    const id = remoteId(value);
    if (id && listed.has(id) && !unplaced.includes(id)) unplaced.push(id);
  }
  return { ...layout, unplaced };
}

/**
 * `/api/workspaces` → rail rows. The base row is the attach path's
 * (normalizeWorkspaces: bounded ids and strings, first row wins on a repeated
 * workspace or session id). A row with no panes is kept only when the host
 * marks it `empty` (parsePcRailWorkspaceExtras).
 */
export function normalizePcRailWorkspaces(body: unknown): PcRailWorkspacesResponse {
  if (!isRecord(body) || !Array.isArray(body.workspaces)) return { workspaces: [] };
  // The first raw row per id, matching the row normalizeWorkspaces kept.
  const rawById = new Map<string, unknown>();
  for (const raw of body.workspaces) {
    const id = isRecord(raw) ? remoteId(raw.id) : undefined;
    if (id && !rawById.has(id)) rawById.set(id, raw);
  }
  const workspaces: PcRailWorkspaceRow[] = [];
  for (const base of normalizeWorkspaces(body)) {
    const raw = rawById.get(base.id);
    const extras = parsePcRailWorkspaceExtras(raw, base.panes.length);
    if (!extras) continue;
    const layout = isRecord(raw) && raw.layout !== undefined
      ? parseRowLayout(raw.layout, new Set(base.panes.map((p) => p.sessionId)))
      : undefined;
    workspaces.push({ ...base, ...extras, ...(layout ? { layout } : {}) });
  }
  const active = remoteId(body.activeWorkspaceId);
  return { workspaces, ...(active && workspaces.some((w) => w.id === active) ? { activeWorkspaceId: active } : {}) };
}

export async function fetchPcRailWorkspaces(host: RemoteHost, fetchImpl: typeof fetch = fetch): Promise<PcRailWorkspacesFetch> {
  const got = await getJson(host, '/api/workspaces', REMOTE_LIMITS.workspacesBodyBytes, fetchImpl);
  if (!got.ok) return got;
  if (!isRecord(got.body) || !Array.isArray(got.body.workspaces)) return { ok: false, reason: 'unavailable' };
  return { ok: true, response: normalizePcRailWorkspaces(got.body) };
}

export async function fetchPcRailApprovals(host: RemoteHost, fetchImpl: typeof fetch = fetch): Promise<PcRailApprovalsResult> {
  const got = await getJson(host, '/api/approvals', APPROVALS_BODY_BYTES, fetchImpl);
  if (!got.ok) return got;
  const approvals = parseRemoteApprovalsList(got.body);
  return approvals ? { ok: true, approvals } : { ok: false, reason: 'unavailable' };
}

/** The host's `allowInput` flag, or undefined when the probe gave no answer. */
export async function probePcRailAllowInput(host: RemoteHost, fetchImpl: typeof fetch = fetch): Promise<boolean | undefined> {
  const got = await getJson(host, '/api/config', REMOTE_LIMITS.smallBodyBytes, fetchImpl);
  if (!got.ok || !isRecord(got.body)) return undefined;
  return got.body.allowInput === true;
}
