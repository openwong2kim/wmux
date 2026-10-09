// PC rail: the one-shot reads the rail makes against a web-paired host.
//
//   GET /api/workspaces  → PcRailWorkspacesResponse (rows widened with the
//                          sidebar extras the attach path drops)
//   GET /api/approvals   → the pending half, through parseRemoteApprovalsList
//   GET /api/config      → allowInput, re-probed every few ticks
//
// Each body is read with a byte cap and every row is bounded before it leaves
// this module. `layout` is not read here: the shadow-workspace builder (PR4)
// parses it with the layout bounds check.

import type { RemoteHost, RemotePaneSummary } from '../../shared/remoteHosts';
import { isRemoteAgentStatus, parseRemoteResumeInfo } from '../../shared/remoteHosts';
import { isCredentialSafeOriginString } from '../../shared/remotePairInput';
import { PHONE_SIDEBAR_LIMITS, clampSidebarString } from '../../shared/phoneFleetSidebar';
import {
  parsePcRailWorkspaceExtras,
  parseRemoteApprovalsList,
  type PcRailApprovalsResult,
  type PcRailWorkspaceRow,
  type PcRailWorkspacesResponse,
} from '../../shared/pcRail';
import type { PcRailFeedFailure } from './pcRailWire';

const REQUEST_TIMEOUT_MS = 10_000;

/** Byte caps per body. A workspace list of 256 rows × panes fits well inside. */
export const PC_RAIL_BODY_LIMITS = {
  workspaces: 4 * 1024 * 1024,
  approvals: 1024 * 1024,
  config: 64 * 1024,
} as const;

/** String caps for row fields that end up in sidebar text. */
const NAME_MAX = 200;
const SHELL_MAX = 64;
const CWD_MAX = 1024;
const AGENT_NAME_MAX = 256;

export type PcRailWorkspacesFetch =
  | { ok: true; response: PcRailWorkspacesResponse }
  | { ok: false; reason: PcRailFeedFailure };

class BodyTooLargeError extends Error {}

/** Read a JSON body, cancelling the stream once it passes `maxBytes`. */
async function readCappedJson(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!res.body) return JSON.parse(await res.text());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

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
    return { ok: true, body: await readCappedJson(res, maxBytes) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= PHONE_SIDEBAR_LIMITS.id ? value : undefined;
}

function normalizePane(raw: unknown): RemotePaneSummary | null {
  if (!isRecord(raw)) return null;
  const sessionId = boundedId(raw.sessionId);
  if (!sessionId) return null;
  const pane: RemotePaneSummary = { sessionId };
  const shell = clampSidebarString(typeof raw.shell === 'string' ? raw.shell : undefined, SHELL_MAX);
  if (shell) pane.shell = shell;
  if (typeof raw.cwd === 'string' && raw.cwd) pane.cwd = raw.cwd.slice(0, CWD_MAX);
  const agentName = clampSidebarString(typeof raw.agentName === 'string' ? raw.agentName : undefined, AGENT_NAME_MAX);
  if (agentName) {
    pane.agentName = agentName;
    if (isRemoteAgentStatus(raw.agentStatus)) pane.agentStatus = raw.agentStatus;
  }
  const resume = parseRemoteResumeInfo(raw.resume);
  if (resume) pane.resume = resume;
  if (typeof raw.commandRunning === 'boolean') pane.commandRunning = raw.commandRunning;
  if (typeof raw.agentProcessAlive === 'boolean') pane.agentProcessAlive = raw.agentProcessAlive;
  return pane;
}

/**
 * `/api/workspaces` → rail rows. Another machine wrote this body, so every
 * row is bounded: at most PHONE_SIDEBAR_LIMITS.workspaces rows and .panes
 * panes in all, bounded ids, cut strings, and the first row wins on a
 * repeated workspace or session id. A row with no panes is kept only when
 * the host marks it `empty` (parsePcRailWorkspaceExtras).
 */
export function normalizePcRailWorkspaces(body: unknown): PcRailWorkspacesResponse {
  if (!isRecord(body) || !Array.isArray(body.workspaces)) return { workspaces: [] };
  const workspaces: PcRailWorkspaceRow[] = [];
  const seenWs = new Set<string>();
  const seenSessions = new Set<string>();
  let paneTotal = 0;
  for (const rawWs of body.workspaces) {
    if (workspaces.length >= PHONE_SIDEBAR_LIMITS.workspaces) break;
    if (!isRecord(rawWs)) continue;
    const id = boundedId(rawWs.id);
    if (!id || seenWs.has(id)) continue;
    const panes: RemotePaneSummary[] = [];
    if (Array.isArray(rawWs.panes)) {
      for (const rawPane of rawWs.panes) {
        if (paneTotal >= PHONE_SIDEBAR_LIMITS.panes) break;
        const pane = normalizePane(rawPane);
        if (!pane || seenSessions.has(pane.sessionId)) continue;
        seenSessions.add(pane.sessionId);
        panes.push(pane);
        paneTotal++;
      }
    }
    const extras = parsePcRailWorkspaceExtras(rawWs, panes.length);
    if (!extras) continue;
    seenWs.add(id);
    const name = clampSidebarString(typeof rawWs.name === 'string' ? rawWs.name : undefined, NAME_MAX) ?? '';
    workspaces.push({ id, name, panes, ...extras });
  }
  const active = boundedId(body.activeWorkspaceId);
  return { workspaces, ...(active && seenWs.has(active) ? { activeWorkspaceId: active } : {}) };
}

export async function fetchPcRailWorkspaces(host: RemoteHost, fetchImpl: typeof fetch = fetch): Promise<PcRailWorkspacesFetch> {
  const got = await getJson(host, '/api/workspaces', PC_RAIL_BODY_LIMITS.workspaces, fetchImpl);
  if (!got.ok) return got;
  if (!isRecord(got.body) || !Array.isArray(got.body.workspaces)) return { ok: false, reason: 'unavailable' };
  return { ok: true, response: normalizePcRailWorkspaces(got.body) };
}

export async function fetchPcRailApprovals(host: RemoteHost, fetchImpl: typeof fetch = fetch): Promise<PcRailApprovalsResult> {
  const got = await getJson(host, '/api/approvals', PC_RAIL_BODY_LIMITS.approvals, fetchImpl);
  if (!got.ok) return got;
  const approvals = parseRemoteApprovalsList(got.body);
  return approvals ? { ok: true, approvals } : { ok: false, reason: 'unavailable' };
}

/** The host's `allowInput` flag, or undefined when the probe gave no answer. */
export async function probePcRailAllowInput(host: RemoteHost, fetchImpl: typeof fetch = fetch): Promise<boolean | undefined> {
  const got = await getJson(host, '/api/config', PC_RAIL_BODY_LIMITS.config, fetchImpl);
  if (!got.ok || !isRecord(got.body)) return undefined;
  return got.body.allowInput === true;
}
