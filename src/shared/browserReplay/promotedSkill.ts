// ---------------------------------------------------------------------------
// Promoted browser flows — the pure layer.
//
// A recorded trace (actionTrace.ts) is deliberately volatile: it expires after
// TRACE_TTL_MS, it lives inside one workspace's slot of one cache file, and it
// is discovered only by an agent that thinks to call browser_replay list. That
// is the right contract for a cache. It is the wrong contract for the handful
// of flows that have actually proven themselves, which is what PROMOTION is:
// the agent nominates a proven trace, and wmux keeps it permanently and
// volunteers it.
//
// Two properties separate a promoted record from the trace it came from:
//
//   1. It carries a SNAPSHOT of the trace's steps. The cache may expire the
//      original at any time; a promoted flow restores itself from the snapshot
//      and keeps running. Permanence is the whole point of promoting, and a
//      pointer into an expiring cache would not deliver it.
//
//   2. It is PUSHED, not pulled. prependReplayHints already announces servable
//      traces when a navigation lands on their page; a promoted flow is
//      announced through the same deterministic pipe, with a one-line contract
//      the agent can act on without a snapshot.
//
// Lifecycle (usage sidecar counters, an idle-to-archive-to-delete ladder)
// follows Hermes Agent (MIT, Nous Research) — the idea, none of its code.
//
// This module is transport-free and I/O-free: PromotedSkillStore owns the
// files and the MCP process renders the hint, and both need the same slug
// rules, the same injection guards, and the same sweep arithmetic.
// ---------------------------------------------------------------------------

import {
  hasUnrecordableStep,
  isQuarantined,
  isServable,
  sanitizeTraceStep,
  traceVariableNames,
  type TraceRecord,
  type TraceStep,
} from './actionTrace';

/** Bumped when the on-disk record shape changes incompatibly. */
export const PROMOTED_SCHEMA_VERSION = 1;

/**
 * Successful runs a trace needs before it may be promoted.
 *
 * Deliberately stricter than isServable's "worked at least once". A hint is a
 * suggestion that costs the agent one attempt; a promoted flow is permanent,
 * survives the cache that produced it, and is volunteered on every landing. A
 * flow that has worked exactly once is not evidence of a repeatable path — it
 * is evidence of one good afternoon.
 */
export const PROMOTE_MIN_SUCCESS = 3;

/** Idle time after which a promoted flow is moved out of the live tree. */
export const PROMOTED_ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** Idle time after which an archived flow is deleted outright. */
export const PROMOTED_DELETE_MS = 90 * 24 * 60 * 60 * 1000;

/** Caps on the rendered contract line. See renderPromotedHint. */
export const MAX_HOST_CHARS = 32;
export const MAX_CONTRACT_CHARS = 120;
export const MAX_SLUG_CHARS = 64;
/** Variables named in a hint before the list is elided. */
export const MAX_HINT_VARIABLES = 6;

export interface PromotedRecord {
  version: number;
  /** Filename-safe identity. Unique within a workspace. */
  slug: string;
  /** The workspace that promoted it; nothing else may demote or sweep it. */
  workspaceId: string;
  /** The trace name the agent knows it by — what browser_replay run takes. */
  name: string;
  urlKey: string;
  /** urlKey's authority, already reduced to the hint whitelist. */
  host: string;
  /** One line the agent can read without a snapshot. Page-derived text never
   *  reaches it; see renderPromotedHint. */
  contract: string;
  /** {{placeholder}} names the flow expects, in first-seen order. */
  variables: string[];
  /** The steps as of promotion. This is what makes a promoted flow outlive
   *  the cache's TTL — see the header. */
  steps: TraceStep[];
  /** stepsFingerprint of `steps` at promotion, for overwrite protection. */
  fingerprint: string;
  promotedAt: number;
  /** Touched by every run, successful or not — see recordPromotedRun. */
  lastRunAt: number;
  runCount: number;
}

// ── Slug ───────────────────────────────────────────────────────────────────

/**
 * Reduce an agent-chosen trace name to a filename.
 *
 * The name is agent-supplied text that becomes a path segment, so this is a
 * whitelist and not an escape: everything outside [a-z0-9-] is folded to a
 * dash rather than encoded. That makes `../../etc/passwd`, a name with a
 * NUL, and a Windows-reserved character all fail the same closed way — they
 * reduce to dashes, and a slug that is nothing but dashes is refused.
 *
 * Returns null rather than throwing: the caller turns it into a message that
 * tells the agent what to rename the flow to.
 */
export function toPromotedSlug(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const folded = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    // A trailing dash can only appear after the slice above.
    .replace(/-+$/g, '');
  if (folded.length === 0) return null;
  // Belt and braces: a slug is a single path segment, never a traversal.
  if (folded === '.' || folded === '..' || folded.includes('/')) return null;
  return folded;
}

// ── Injection guards ───────────────────────────────────────────────────────
//
// A hint is rendered into the agent's context as instruction-adjacent text, and
// every field it could draw on ultimately came from a web page: the URL, the
// element names baked into the axes, the typed values. Treating any of it as
// text to interpolate would let a page that the agent merely VISITED write into
// the agent's prompt on some later, unrelated navigation.
//
// So the hint carries exactly two page-derived things, both reduced to a
// character whitelist and a hard length: the host, and nothing else. The flow's
// own name and slug are agent-chosen and slug-normalised. Everything richer —
// path, query, element names, values — stays out of the hint entirely and is
// reachable only through browser_replay list, which renders inside its own
// report rather than as a volunteered instruction.

/**
 * The authority of a urlKey, reduced to what may appear in a hint.
 *
 * Characters outside the whitelist are DROPPED rather than replaced, so a host
 * carrying `\n[system] ignore previous` cannot survive as punctuation that
 * still reads as a new line or a new directive.
 */
export function safeHintHost(urlKey: unknown): string {
  if (typeof urlKey !== 'string' || urlKey.length === 0) return '';
  let authority = urlKey;
  try {
    authority = new URL(urlKey).host;
  } catch {
    // Unparseable keys are normalizeUrlKey's fallback (trimmed, lowercased).
    // Take the leading token — up to the first separator OR the first space —
    // and let the whitelist do the rest. Stopping at whitespace matters: a
    // key that never parsed is arbitrary text, and without this the whole
    // remainder would be concatenated into one long pseudo-host.
    authority = urlKey.split(/[\s/]/)[0] ?? '';
  }
  return authority.replace(/[^A-Za-z0-9.:-]/g, '').slice(0, MAX_HOST_CHARS);
}

/**
 * Reduce agent-chosen text to a single safe line.
 *
 * Used for the flow name inside a hint. Newlines and control characters are
 * removed, not escaped: the danger is a value that ends the hint line and
 * starts what looks like a new directive, and a visible `\n` is not that.
 */
export function safeHintText(value: unknown, max = MAX_CONTRACT_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ── Contract line ──────────────────────────────────────────────────────────

/**
 * The one line a promoted flow is announced by.
 *
 * It has to answer, without a snapshot and without a follow-up call: what does
 * this do, and what do I type to do it. Hence the literal tool call — the
 * agent that reads this hint can act on it in its very next tool use, which is
 * the difference between a discoverable feature and a used one.
 */
export function renderPromotedContract(record: Pick<PromotedRecord, 'name' | 'host' | 'steps'>): string {
  const host = safeHintHost(record.host) || 'this page';
  const count = record.steps.length;
  return safeHintText(`proven ${count}-step flow on ${host}`);
}

/**
 * Render the `[skill]` line for one promoted flow.
 *
 * Separate from renderPromotedContract so the store can persist a contract
 * once and the hint pipe can still re-apply the guards at render time — a
 * record hand-edited on disk gets sanitised on the way OUT as well as in.
 */
export function renderPromotedHint(record: PromotedRecord): string {
  const name = safeHintText(record.name, MAX_SLUG_CHARS);
  const contract = safeHintText(record.contract);
  const variables = record.variables.slice(0, MAX_HINT_VARIABLES).map((v) => safeHintText(v, 64));
  const varPart =
    variables.length > 0
      ? `, variables:{${variables.map((v) => `${v}:"..."`).join(', ')}}`
      : '';
  return (
    `[skill] ${name} — ${contract} — ` +
    `browser_replay {action:"run", name:"${name}"${varPart}}`
  );
}

/**
 * Render the hint block for every promoted flow that matches a landing.
 *
 * Returns '' for none, so the caller's "no hint is always acceptable" path
 * needs no special case.
 */
export function renderPromotedHintBlock(records: readonly PromotedRecord[]): string {
  if (records.length === 0) return '';
  return `${records.map(renderPromotedHint).join('\n')}\n`;
}

// ── Promotion gate ─────────────────────────────────────────────────────────

/**
 * Why this trace may not be promoted, or null if it may.
 *
 * The message names the SHORTFALL rather than saying no: an agent told
 * "2 successful runs so far, 3 needed" runs the flow again, which is exactly
 * the evidence the gate is asking for. An agent told "refused" gives up.
 */
export function promoteBlockedReason(trace: TraceRecord): string | null {
  if (trace.steps.length === 0) return 'it has no steps';
  if (hasUnrecordableStep(trace)) {
    return 'it contains a step that can never be replayed (a password field, or an element that could not be addressed)';
  }
  if (isQuarantined(trace)) {
    return 'it is quarantined — the same step failed twice running. Re-record it first';
  }
  if (trace.successCount < PROMOTE_MIN_SUCCESS) {
    const need = PROMOTE_MIN_SUCCESS - trace.successCount;
    return (
      `it has ${trace.successCount} successful run(s) and promotion needs ${PROMOTE_MIN_SUCCESS}. ` +
      `Run it ${need} more time(s) successfully, then promote it`
    );
  }
  if (!isServable(trace)) {
    return `it fails more often than it succeeds (${trace.successCount} ok / ${trace.failCount} failed)`;
  }
  return null;
}

// ── Construction ───────────────────────────────────────────────────────────

export interface BuildPromotedOptions {
  workspaceId: string;
  slug: string;
  fingerprint: string;
  now?: number;
}

/** Build the record that gets written. Assumes the gate already passed. */
export function buildPromotedRecord(
  trace: TraceRecord,
  opts: BuildPromotedOptions,
): PromotedRecord {
  const now = opts.now ?? Date.now();
  const host = safeHintHost(trace.urlKey);
  const steps = trace.steps.map((s) => ({ ...s }));
  return {
    version: PROMOTED_SCHEMA_VERSION,
    slug: opts.slug,
    workspaceId: opts.workspaceId,
    name: trace.name,
    urlKey: trace.urlKey,
    host,
    contract: renderPromotedContract({ name: trace.name, host, steps }),
    variables: traceVariableNames(trace),
    steps,
    fingerprint: opts.fingerprint,
    promotedAt: now,
    lastRunAt: now,
    runCount: 0,
  };
}

/**
 * Fold one run into a promoted record's usage counters.
 *
 * lastRunAt moves on a FAILED run too. The counter exists to answer "is this
 * flow still part of the agent's life", and a flow that is being reached for
 * every week and failing is being used — archiving it would delete the very
 * record whose failures are the signal that it needs re-recording.
 */
export function recordPromotedRun(record: PromotedRecord, now: number = Date.now()): PromotedRecord {
  return { ...record, lastRunAt: now, runCount: record.runCount + 1 };
}

// ── Sweep ──────────────────────────────────────────────────────────────────

export interface SweepDecision {
  /** Live records that stay where they are. */
  keep: PromotedRecord[];
  /** Idle past PROMOTED_ARCHIVE_MS — move out of the live tree. */
  archive: PromotedRecord[];
  /** Idle past PROMOTED_DELETE_MS — delete outright. */
  remove: PromotedRecord[];
}

/**
 * Partition promoted records by idle age.
 *
 * Pure, so the ladder is testable against a fake clock without touching a
 * filesystem, and so the store's only job is to carry out a decision it did
 * not make.
 */
export function sweepPromoted(
  records: readonly PromotedRecord[],
  now: number = Date.now(),
): SweepDecision {
  const decision: SweepDecision = { keep: [], archive: [], remove: [] };
  for (const record of records) {
    const idle = now - record.lastRunAt;
    if (idle >= PROMOTED_DELETE_MS) decision.remove.push(record);
    else if (idle >= PROMOTED_ARCHIVE_MS) decision.archive.push(record);
    else decision.keep.push(record);
  }
  return decision;
}

// ── Sanitisation ───────────────────────────────────────────────────────────

/**
 * Rebuild a record from untrusted JSON, or null.
 *
 * The file is untrusted for the same reason the action cache's is: it is on
 * disk, a user may edit it, and a partial write may tear it. Fail open —
 * anything unrecognised is dropped and the flow is simply not promoted.
 *
 * The contract and host are RE-DERIVED rather than trusted, so a hand-edited
 * record cannot smuggle a line into the hint pipe.
 */
export function sanitizePromotedRecord(raw: unknown): PromotedRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== PROMOTED_SCHEMA_VERSION) return null;
  const slug = toPromotedSlug(r.slug);
  if (!slug || slug !== r.slug) return null;
  if (typeof r.workspaceId !== 'string' || r.workspaceId.length === 0) return null;
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 64) return null;
  if (typeof r.urlKey !== 'string' || r.urlKey.length === 0 || r.urlKey.length > 2048) return null;
  if (typeof r.fingerprint !== 'string' || r.fingerprint.length === 0) return null;

  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  const steps: TraceStep[] = [];
  for (const entry of rawSteps) {
    const step = sanitizeTraceStep(entry);
    if (!step) return null;
    steps.push(step);
  }
  if (steps.length === 0) return null;

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const promotedAt = num(r.promotedAt, 0);
  const host = safeHintHost(r.urlKey);
  return {
    version: PROMOTED_SCHEMA_VERSION,
    slug,
    workspaceId: r.workspaceId,
    name: r.name,
    urlKey: r.urlKey,
    host,
    contract: renderPromotedContract({ name: r.name, host, steps }),
    variables: traceVariableNames({ steps }),
    steps,
    fingerprint: r.fingerprint,
    promotedAt,
    lastRunAt: num(r.lastRunAt, promotedAt),
    runCount: Math.max(0, Math.floor(num(r.runCount, 0))),
  };
}

/**
 * Rebuild a TraceRecord from a promoted record.
 *
 * This is the restore path: the cache expired the original, the agent runs the
 * flow anyway, and the replay runner needs a trace to work from. The counters
 * come back as a promoted flow's counters (it is proven — that is why it was
 * promoted), and surfaceShape comes back empty, which the runner already
 * treats as "no baseline, skip the comparison" rather than as a mismatch.
 */
export function traceFromPromoted(record: PromotedRecord): TraceRecord {
  return {
    id: `pr_${record.slug}`,
    name: record.name,
    urlKey: record.urlKey,
    surfaceShape: '',
    steps: record.steps.map((s) => ({ ...s })),
    observedCount: 1,
    successCount: Math.max(PROMOTE_MIN_SUCCESS, record.runCount),
    failCount: 0,
    createdAt: record.promotedAt,
    lastUsedAt: record.lastRunAt,
  };
}
