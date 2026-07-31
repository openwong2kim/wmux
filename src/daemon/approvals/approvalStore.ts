// M2 — durability for the approval registry.
//
// `approvals.json`, next to sessions.json in the suffix-aware wmux data dir,
// written with the daemon's own atomic helpers (`atomicWriteJSON` /
// `atomicReadJSONSync` — the same pair deckAutonomyStore and deckDecisionStore
// use) and coerced per-field on read in the webStateStore (#596) style: one
// torn record must never discard the rest of the file, and a file we cannot
// make sense of degrades to "no approvals" rather than throwing the daemon's
// boot.
//
// Nothing here is security state — the bearer token that gates the HTTP
// surface lives in web-state.json. What a hostile writer of this file could do
// is show a phone a request that resolves to nothing, because every resolve
// re-checks the live session and re-reads the screen before it writes a byte.

import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../util/atomicWrite';
import { sanitizeChoices, sanitizeOptions, sanitizeQuestion } from './askUserQuestion';
import type { ApprovalDecision, ApprovalRequest, ApprovalState } from './types';

const STATE_FILE = 'approvals.json';

/**
 * How many TERMINAL records ride along in the file (and in memory).
 *
 * They exist for the 409 UX — "already answered by <who>" is only possible if
 * the loser can still find the record. Bounded because a long-lived daemon
 * would otherwise grow this file for the lifetime of the machine, and because
 * every record may carry a screen tail.
 */
export const RESOLVED_HISTORY_CAP = 20;

/** Rows of pane text kept on a record, and the per-row character cap. */
export const SCREEN_TAIL_ROWS = 12;
export const SCREEN_TAIL_ROW_CHARS = 200;

export interface ApprovalPersistedState {
  version: 1;
  requests: ApprovalRequest[];
}

export const EMPTY_APPROVAL_STATE: Readonly<ApprovalPersistedState> = Object.freeze({
  version: 1 as const,
  requests: [] as ApprovalRequest[],
});

export function getApprovalStatePath(wmuxDir: string): string {
  return path.join(wmuxDir, STATE_FILE);
}

const STATES: ReadonlySet<string> = new Set<ApprovalState>([
  'pending',
  'resolved',
  'expired',
  'superseded',
]);

const DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>(['approve', 'deny']);

/**
 * Coerce one raw entry. Unlike webStateStore's per-FIELD fallback, a record
 * missing any of its identity fields (id / sessionId / agent / createdAt /
 * state) is DROPPED rather than defaulted: there is no safe stand-in for "which
 * pane does this keystroke go to", and a half-invented record is worse than an
 * absent one.
 */
function coerceRequest(raw: unknown): ApprovalRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : '';
  const sessionId = typeof o['sessionId'] === 'string' ? o['sessionId'] : '';
  const agent = typeof o['agent'] === 'string' ? o['agent'] : '';
  const createdAt = typeof o['createdAt'] === 'number' && Number.isFinite(o['createdAt'])
    ? o['createdAt']
    : NaN;
  const state = typeof o['state'] === 'string' && STATES.has(o['state'])
    ? (o['state'] as ApprovalState)
    : null;
  if (!id || !sessionId || !agent || !Number.isFinite(createdAt) || !state) return null;

  const out: ApprovalRequest = {
    id,
    sessionId,
    agent,
    kind: 'awaiting_input',
    createdAt,
    state,
  };
  if (typeof o['workspaceId'] === 'string' && o['workspaceId']) out.workspaceId = o['workspaceId'];
  // Bounded on the way in for the same reason `question`/`options` are, below:
  // this is plain JSON on disk. Doing it only for the fields the extractor
  // happens to touch left the two that a resolve writes — the label and the
  // captured screen — able to come back unbounded and carry control characters
  // into a log line and an HTTP response.
  if (typeof o['resolvedBy'] === 'string') out.resolvedBy = sanitizeResolvedBy(o['resolvedBy']);
  if (typeof o['resolvedAt'] === 'number' && Number.isFinite(o['resolvedAt'])) {
    out.resolvedAt = o['resolvedAt'];
  }
  if (typeof o['decision'] === 'string' && DECISIONS.has(o['decision'])) {
    out.decision = o['decision'] as ApprovalDecision;
  }
  if (typeof o['screenTail'] === 'string') {
    out.screenTail = formatScreenTail(o['screenTail'].split(/\r?\n/));
  }
  // A4: re-sanitize on the way IN, not just on the way out of the extractor.
  // This file is plain JSON on disk — a hand-edit, or a record written by a
  // build with looser caps, must not put an unbounded or control-char-bearing
  // string into an HTTP response.
  const question = sanitizeQuestion(o['question']);
  if (question) out.question = question;
  const options = sanitizeOptions(o['options']);
  if (options) out.options = options;
  const choices = sanitizeChoices(o['choices']);
  if (choices) out.choices = choices;
  // selectedChoiceKey: a 1-2 digit string, validated against the choices set.
  if (typeof o['selectedChoiceKey'] === 'string' && /^\d{1,2}$/.test(o['selectedChoiceKey'])) {
    out.selectedChoiceKey = o['selectedChoiceKey'];
  }
  // Closed set of one: anything else on disk is dropped rather than passed
  // through, so a hand-edited file cannot invent a risk level a client would
  // then have to interpret.
  if (o['risk'] === 'critical') out.risk = 'critical';
  return out;
}

export function coerceApprovalState(parsed: unknown): ApprovalPersistedState {
  if (typeof parsed !== 'object' || parsed === null) return { version: 1, requests: [] };
  const o = parsed as Record<string, unknown>;
  const rawList = Array.isArray(o['requests']) ? o['requests'] : [];
  const requests: ApprovalRequest[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const req = coerceRequest(raw);
    // Duplicate ids would make CAS ambiguous (which record did we just flip?).
    // First occurrence wins; the rest are dropped.
    if (!req || seen.has(req.id)) continue;
    seen.add(req.id);
    requests.push(req);
  }
  return { version: 1, requests };
}

/**
 * Read the file. Any failure — missing, unreadable, malformed, wrong types —
 * degrades to an empty set. A corrupt approvals file must never keep the daemon
 * from booting, and "no pending approvals" is the safe direction for a surface
 * whose whole purpose is to press keys into terminals.
 */
export function loadApprovalState(wmuxDir: string): ApprovalPersistedState {
  try {
    const parsed = atomicReadJSONSync<unknown>(getApprovalStatePath(wmuxDir));
    if (parsed === null) return { version: 1, requests: [] };
    return coerceApprovalState(parsed);
  } catch {
    return { version: 1, requests: [] };
  }
}

/**
 * Persist. Best-effort and non-throwing, mirroring saveWebState: the mutation
 * the caller just made ALREADY HAPPENED in memory (and, for a resolve, the
 * bytes are already in the PTY), so failing the caller here would report a
 * false negative for work that is done. Returns false so the caller can log the
 * degraded outcome — the cost of a lost write is that a restart forgets a
 * resolved record, and every pending one is expired on restart anyway.
 */
export async function saveApprovalState(
  wmuxDir: string,
  state: ApprovalPersistedState,
): Promise<boolean> {
  try {
    await atomicWriteJSON(getApprovalStatePath(wmuxDir), state);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim terminal records to the history cap, keeping the newest. Pending records
 * are never trimmed — they are live state, not history, and there is exactly
 * one per session by construction (the supersede rule).
 */
export function trimHistory(requests: readonly ApprovalRequest[]): ApprovalRequest[] {
  const pending = requests.filter((r) => r.state === 'pending');
  const terminal = requests
    .filter((r) => r.state !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt))
    .slice(0, RESOLVED_HISTORY_CAP);
  return [...pending, ...terminal];
}

/** Bound a captured pane tail so a record can never carry a screenful of noise. */
/** Longest `resolvedBy` we will persist. Room for a device name plus a UUID. */
export const RESOLVED_BY_MAX = 128;

/**
 * Bound and clean the "who answered this" label.
 *
 * Applied HERE rather than at each caller because this is the chokepoint every
 * path funnels through, and the two callers got it wrong in opposite
 * directions: the HTTP route passed a hardcoded constant and threw the
 * authenticated principal away, while `daemon.approvals.resolve` accepted any
 * string a pipe client sent, with no cap and no control-character strip. The
 * string is persisted per record in approvals.json, interpolated into a daemon
 * log line, and handed back to the loser of a race in a 409 body — so an
 * unbounded one is file growth, log injection, and a response payload at once.
 * `question` and `options` are already sanitized on the way in; this closes the
 * last field that was not.
 */
export function sanitizeResolvedBy(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > RESOLVED_BY_MAX ? cleaned.slice(0, RESOLVED_BY_MAX) : cleaned;
}

export function formatScreenTail(rows: readonly string[]): string {
  return rows
    .slice(-SCREEN_TAIL_ROWS)
    .map((row) => (row.length > SCREEN_TAIL_ROW_CHARS ? row.slice(0, SCREEN_TAIL_ROW_CHARS) : row))
    .join('\n');
}
