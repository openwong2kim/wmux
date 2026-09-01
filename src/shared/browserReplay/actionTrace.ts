// ---------------------------------------------------------------------------
// Browser action traces — the pure layer.
//
// A trace is a recorded sequence of successful browser actions that can be
// replayed later without the agent re-reading a snapshot. The saving is not
// the round trips: it is the SNAPSHOT the agent no longer has to read and
// reason about on every repetition of the same flow.
//
// mirrors stagehand packages/extension/services/cacheService.ts withCache —
// three of its operating principles, none of its code:
//   1. best-effort: a cache miss, a shape mismatch, or a malformed record must
//      never break the underlying action. The worst outcome is that the agent
//      does the work the slow way.
//   2. replay-fallback self-heal: a replay that stops mid-way reports WHERE and
//      WHY and hands the page back live, so the agent finishes by hand and the
//      next save records the healed path.
//   3. variable placeholders: a value the caller wants to vary between runs is
//      stored as `{{name}}` and substituted at replay time, so the trace never
//      holds the value itself.
// Stagehand caches on an XPath axis; wmux does not (see RefAxis).
//
// This module is deliberately transport-free and I/O-free: main owns the file
// (ActionCacheStore) and the MCP process owns the recorder and the runner, and
// both need the same vocabulary, caps, and hashing rules.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';

/** Tools whose successful invocations may enter a trace. */
export const REPLAYABLE_TOOLS = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_select',
  'browser_scroll_into_view',
  'browser_scroll',
] as const;

export type ReplayableTool = (typeof REPLAYABLE_TOOLS)[number];

export function isReplayableTool(value: unknown): value is ReplayableTool {
  return typeof value === 'string' && (REPLAYABLE_TOOLS as readonly string[]).includes(value);
}

// ── Element axis ───────────────────────────────────────────────────────────
//
// The axis is what a step re-resolves against on replay. It is the snapshot's
// own RefEntry 4-tuple (role, name, sameNameIndex, sameNameTotal) and NOT an
// XPath or a DOM path: the 4-tuple is exactly what resolveRef already counts
// against, so a replayed step inherits the same staleness contract — including
// the "the population changed, refuse rather than guess" rule — instead of
// inventing a second, weaker one. A DOM restructure that leaves the button
// still reading as `button "Sign in"` re-resolves; an XPath would not.

/** An element addressed the way browser_snapshot addresses it. */
export interface RefAxis {
  kind: 'ref';
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  /** frameKeyOf(RefEntry.framePath). `''` = main frame. */
  frameKey: string;
}

/** An element addressed by the CSS selector browser_smart_snapshot minted. */
export interface CssAxis {
  kind: 'css';
  selector: string;
}

/** The step acts on the page, not on an element (navigate, press_key, scroll). */
export interface NoAxis {
  kind: 'none';
}

export type StepAxis = RefAxis | CssAxis | NoAxis;

export const NO_AXIS: NoAxis = Object.freeze({ kind: 'none' });

/** Why a recorded step can be listed but never replayed. */
export type UnrecordableReason =
  /** The step typed into a password field. The value was never captured. */
  | 'password'
  /** The action ran over the RPC lane, which mints no RefEntry to key on. */
  | 'rpc-transport'
  /** The element could not be reduced to any axis this version understands. */
  | 'unresolved-axis';

export interface TraceStep {
  tool: ReplayableTool;
  axis: StepAxis;
  /** Second element for the two-element tools (browser_drag's target). */
  target2?: StepAxis;
  /** Literal tool arguments, or `{{name}}` placeholders. */
  args: Record<string, string | number | boolean>;
  /**
   * Present iff the step is a HOLE: it happened, it is listed so the recorded
   * flow reads honestly, and any trace containing one refuses to run. A silent
   * omission would produce a trace that replays a DIFFERENT flow than the one
   * the agent performed, which is worse than no trace.
   */
  unrecordable?: UnrecordableReason;
}

export interface TraceRecord {
  id: string;
  /** Unique within a workspace; how an agent names the trace. */
  name: string;
  /** origin + pathname of the page the flow started on. */
  urlKey: string;
  /** Ref-number-independent hash of the page the flow was recorded against. */
  surfaceShape: string;
  steps: TraceStep[];
  /** How many times the flow was recorded (a save over an existing name). */
  observedCount: number;
  successCount: number;
  failCount: number;
  /** 1-based index of the step the last failed run stopped at. */
  lastFailStep?: number;
  /** Consecutive failures at `lastFailStep`. Two of them quarantine. */
  consecutiveFailsAtStep?: number;
  createdAt: number;
  lastUsedAt: number;
}

// ── Caps ───────────────────────────────────────────────────────────────────
//
// Every one of these is a containment bound, not a capacity target. The cache
// is an optimization: it may lose an entry at any time without anything
// breaking, so the bounds are set where a runaway recorder cannot turn a
// convenience file into a liability.

/** Traces kept per workspace. Over the cap, least-recently-used lose. */
export const MAX_TRACES_PER_WORKSPACE = 40;
/** Steps per trace. A longer flow is not a "trace", it is a script. */
export const MAX_STEPS_PER_TRACE = 30;
/** Bytes per single argument value. Longer values are truncation-marked. */
export const MAX_ARG_BYTES = 512;
/** Whole-file ceiling; over it the oldest workspaces are dropped. */
export const MAX_FILE_BYTES = 512 * 1024;
/** A trace unused for this long is forgotten on the next load. */
export const TRACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Consecutive failures at one step before a trace stops being served. */
export const QUARANTINE_FAIL_STREAK = 2;
/** Actions held in the per-connection recording ring. */
export const ACTION_RING_CAPACITY = 40;

// ── URL key ────────────────────────────────────────────────────────────────

/**
 * The page identity a trace is filed under: origin + pathname.
 *
 * Query and fragment are dropped deliberately — a search page differs from its
 * own results only in the query, and a flow recorded on one is the same flow on
 * the other. Credentials in the authority are dropped with the authority's
 * userinfo, so a urlKey can never carry one.
 *
 * A URL that does not parse is returned trimmed and lowercased rather than
 * refused: a trace filed under a slightly odd key still only ever matches
 * itself, whereas a throw here would take down the tool that called it.
 */
export function normalizeUrlKey(url: string): string {
  const raw = (url ?? '').trim();
  try {
    const parsed = new URL(raw);
    // Never let userinfo into a stored key.
    parsed.username = '';
    parsed.password = '';
    const path = parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    return `${parsed.origin}${path}`;
  } catch {
    return raw.toLowerCase();
  }
}

// ── Surface shape ──────────────────────────────────────────────────────────

/** `ref=12` / `[ref=12]` / `ref="12"` in any snapshot rendering. */
const REF_NUMBER_PATTERN = /\bref\s*=\s*"?\[?(\d+)\]?"?/g;

/**
 * A hash of "what this page looks like", with the ref NUMBERS removed.
 *
 * Ref numbers are minted per document and change whenever the identity map is
 * rebuilt, so hashing the raw snapshot would report every page as a different
 * page and make the shape check pure noise. Stripping them leaves the roles,
 * names and structure — the things a trace actually depends on.
 *
 * A mismatch is a WARNING, never a refusal (best-effort principle above): the
 * page having gained a banner does not stop a login flow from working, and the
 * step-level axis resolution is the real correctness check.
 */
export function surfaceShapeHash(snapshotText: string): string {
  const normalized = (snapshotText ?? '')
    .replace(REF_NUMBER_PATTERN, 'ref=#')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

// ── Axis construction ──────────────────────────────────────────────────────

/** The RefEntry fields an axis is built from. Structural on purpose: the
 *  recorder lives in the MCP process and must not drag snapshot.ts (and its
 *  playwright-core types) into the shared layer. */
export interface RefEntryLike {
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  frameKey: string;
}

/**
 * Reduce a live RefEntry to a storable axis.
 *
 * A ref with an unusable role is refused (null) rather than stored as a
 * degenerate axis that would match the first thing on the page at replay time.
 */
export function refEntryToAxis(entry: RefEntryLike | null | undefined): RefAxis | null {
  if (!entry) return null;
  if (typeof entry.role !== 'string' || entry.role.length === 0) return null;
  const index = Number.isInteger(entry.sameNameIndex) ? entry.sameNameIndex : 0;
  const total = Number.isInteger(entry.sameNameTotal) && entry.sameNameTotal > 0
    ? entry.sameNameTotal
    : 1;
  return {
    kind: 'ref',
    role: entry.role,
    name: typeof entry.name === 'string' ? entry.name : '',
    sameNameIndex: index,
    sameNameTotal: total,
    frameKey: typeof entry.frameKey === 'string' ? entry.frameKey : '',
  };
}

/** Human-readable axis, for step reports and the list view. */
export function describeAxis(axis: StepAxis): string {
  switch (axis.kind) {
    case 'ref': {
      const where = axis.frameKey ? ` in frame ${axis.frameKey}` : '';
      const nth = axis.sameNameTotal > 1
        ? ` (#${axis.sameNameIndex + 1} of ${axis.sameNameTotal})`
        : '';
      return `${axis.role} "${axis.name}"${nth}${where}`;
    }
    case 'css':
      return `css ${axis.selector}`;
    case 'none':
      return 'page';
  }
}

// ── Variables ──────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g;

export interface VariableSubstitution {
  args: Record<string, string | number | boolean>;
  /** Placeholders the caller did not supply a value for. */
  missing: string[];
}

/**
 * Substitute `{{name}}` placeholders in a step's arguments.
 *
 * The trace stores the placeholder, never the value: that is what lets a login
 * flow be saved at all without the password ever reaching disk, and what lets
 * one trace serve many inputs. A placeholder with no supplied value is
 * REPORTED, not left in place — replaying a literal `{{email}}` into a form is
 * a silently wrong run.
 */
export function applyVariables(
  args: Record<string, string | number | boolean>,
  variables: Record<string, string> | undefined,
): VariableSubstitution {
  const missing = new Set<string>();
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    out[key] = value.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
      const supplied = variables?.[name];
      if (typeof supplied !== 'string') {
        missing.add(name);
        return whole;
      }
      return supplied;
    });
  }
  return { args: out, missing: [...missing] };
}

/** Placeholder names a trace expects, in first-seen order. */
export function traceVariableNames(trace: Pick<TraceRecord, 'steps'>): string[] {
  const names: string[] = [];
  for (const step of trace.steps) {
    for (const value of Object.values(step.args ?? {})) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
        if (!names.includes(match[1])) names.push(match[1]);
      }
    }
  }
  return names;
}

// ── Argument clamping ──────────────────────────────────────────────────────

/**
 * Clamp one argument value to MAX_ARG_BYTES.
 *
 * Truncation is MARKED, not silent: a half-typed string replayed as if it were
 * the whole one is a wrong run that looks like a right one. A marked value
 * makes the step unrecordable at save time instead.
 */
export function clampArgValue(
  value: string | number | boolean,
): { value: string | number | boolean; truncated: boolean } {
  if (typeof value !== 'string') return { value, truncated: false };
  if (Buffer.byteLength(value, 'utf8') <= MAX_ARG_BYTES) return { value, truncated: false };
  // Cut on a byte budget, then repair any split surrogate/multi-byte tail.
  const cut = Buffer.from(value, 'utf8').subarray(0, MAX_ARG_BYTES).toString('utf8');
  const repaired = cut.endsWith('�') ? cut.slice(0, -1) : cut;
  return { value: repaired, truncated: true };
}

// ── Serving rules ──────────────────────────────────────────────────────────

/** A trace with any hole in it can be listed but never run. */
export function hasUnrecordableStep(trace: Pick<TraceRecord, 'steps'>): boolean {
  return trace.steps.some((step) => step.unrecordable !== undefined);
}

/** Quarantined: the same step failed QUARANTINE_FAIL_STREAK times running. */
export function isQuarantined(trace: TraceRecord): boolean {
  return (trace.consecutiveFailsAtStep ?? 0) >= QUARANTINE_FAIL_STREAK;
}

/**
 * May this trace be offered to the agent as a hint?
 *
 * Deliberately stricter than "may it run": an unproven or flaky trace is still
 * runnable on request, but suggesting it costs the agent an attempt it did not
 * ask for. So a hint needs a trace that has worked at least once and fails
 * less often than it succeeds.
 */
export function isServable(trace: TraceRecord): boolean {
  if (trace.steps.length === 0) return false;
  if (hasUnrecordableStep(trace)) return false;
  if (isQuarantined(trace)) return false;
  return trace.successCount >= 1 && trace.failCount < trace.successCount;
}

export interface RunOutcome {
  ok: boolean;
  /** 1-based step index a failed run stopped at. */
  failedStep?: number;
  now?: number;
}

/**
 * Fold one replay's result into a trace's statistics.
 *
 * The failure STREAK is per-step, not global: a trace that fails once at step 4
 * for a transient reason and then succeeds must not carry that failure toward
 * quarantine, while a step that is genuinely gone fails at the same index every
 * time and quarantines on the second try.
 */
export function applyRunOutcome(trace: TraceRecord, outcome: RunOutcome): TraceRecord {
  const now = outcome.now ?? Date.now();
  if (outcome.ok) {
    return {
      ...trace,
      successCount: trace.successCount + 1,
      lastUsedAt: now,
      consecutiveFailsAtStep: 0,
      ...(trace.lastFailStep !== undefined && { lastFailStep: trace.lastFailStep }),
    };
  }
  const sameStep = outcome.failedStep !== undefined && trace.lastFailStep === outcome.failedStep;
  return {
    ...trace,
    failCount: trace.failCount + 1,
    lastUsedAt: now,
    ...(outcome.failedStep !== undefined && { lastFailStep: outcome.failedStep }),
    consecutiveFailsAtStep: sameStep ? (trace.consecutiveFailsAtStep ?? 0) + 1 : 1,
  };
}

// ── Pruning ────────────────────────────────────────────────────────────────

/**
 * Enforce the per-workspace caps: TTL first, then LRU down to the cap.
 *
 * TTL before LRU on purpose — an expired trace must go even when the workspace
 * is under the count cap, or a rarely-used workspace would serve traces
 * recorded against a page that has since been redesigned twice.
 */
export function pruneTraces(traces: readonly TraceRecord[], now: number = Date.now()): TraceRecord[] {
  const fresh = traces.filter((t) => now - t.lastUsedAt <= TRACE_TTL_MS);
  if (fresh.length <= MAX_TRACES_PER_WORKSPACE) return [...fresh];
  return [...fresh]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_TRACES_PER_WORKSPACE);
}

// ── Sanitisation ───────────────────────────────────────────────────────────
//
// The store's file and the save RPC's payload are both untrusted input, and
// both land in the same shape. Sanitising in ONE place is what keeps a
// hand-edited cache file and a malformed tool call from needing two different
// (and eventually divergent) sets of guards. Fail open: anything unrecognised
// is dropped, never thrown on — a torn cache must cost the agent its traces
// and nothing else.

const UNRECORDABLE_REASONS: readonly UnrecordableReason[] = [
  'password',
  'rpc-transport',
  'unresolved-axis',
];

function sanitizeAxis(raw: unknown): StepAxis | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.kind === 'none') return NO_AXIS;
  if (a.kind === 'css') {
    return typeof a.selector === 'string' && a.selector.length > 0 && a.selector.length <= 512
      ? { kind: 'css', selector: a.selector }
      : null;
  }
  if (a.kind !== 'ref') return null;
  if (typeof a.role !== 'string' || a.role.length === 0 || a.role.length > 64) return null;
  const name = typeof a.name === 'string' ? a.name.slice(0, MAX_ARG_BYTES) : '';
  const sameNameIndex = Number.isInteger(a.sameNameIndex) ? (a.sameNameIndex as number) : 0;
  const sameNameTotal = Number.isInteger(a.sameNameTotal) && (a.sameNameTotal as number) > 0
    ? (a.sameNameTotal as number)
    : 1;
  if (sameNameIndex < 0 || sameNameIndex >= sameNameTotal) return null;
  return {
    kind: 'ref',
    role: a.role,
    name,
    sameNameIndex,
    sameNameTotal,
    frameKey: typeof a.frameKey === 'string' ? a.frameKey.slice(0, 256) : '',
  };
}

function sanitizeArgs(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_]{1,48}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = clampArgValue(value).value;
  }
  return out;
}

export function sanitizeTraceStep(raw: unknown): TraceStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isReplayableTool(s.tool)) return null;
  const axis = sanitizeAxis(s.axis);
  if (!axis) return null;
  const target2 = s.target2 === undefined ? undefined : sanitizeAxis(s.target2);
  // A drag whose target does not survive sanitising is a hole, not a click.
  const targetLost = s.target2 !== undefined && target2 === null;
  const reason = UNRECORDABLE_REASONS.includes(s.unrecordable as UnrecordableReason)
    ? (s.unrecordable as UnrecordableReason)
    : targetLost
      ? 'unresolved-axis'
      : undefined;
  return {
    tool: s.tool,
    axis,
    ...(target2 && { target2 }),
    args: sanitizeArgs(s.args),
    ...(reason && { unrecordable: reason }),
  };
}

/** Trace names are agent-chosen and become map keys and report text. */
export const TRACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/;

export function isValidTraceName(name: unknown): name is string {
  return typeof name === 'string' && TRACE_NAME_PATTERN.test(name);
}

export function sanitizeTraceRecord(raw: unknown, now: number = Date.now()): TraceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidTraceName(r.name)) return null;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 64) return null;
  if (typeof r.urlKey !== 'string' || r.urlKey.length === 0 || r.urlKey.length > 2048) return null;
  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  const steps: TraceStep[] = [];
  for (const entry of rawSteps.slice(0, MAX_STEPS_PER_TRACE)) {
    const step = sanitizeTraceStep(entry);
    if (step) steps.push(step);
  }
  if (steps.length === 0) return null;
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now;
  const lastUsedAt = typeof r.lastUsedAt === 'number' && Number.isFinite(r.lastUsedAt)
    ? r.lastUsedAt
    : createdAt;
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return {
    id: r.id,
    name: r.name,
    urlKey: r.urlKey,
    surfaceShape: typeof r.surfaceShape === 'string' ? r.surfaceShape.slice(0, 64) : '',
    steps,
    observedCount: count(r.observedCount),
    successCount: count(r.successCount),
    failCount: count(r.failCount),
    ...(Number.isInteger(r.lastFailStep) && (r.lastFailStep as number) > 0 && {
      lastFailStep: r.lastFailStep as number,
    }),
    ...(count(r.consecutiveFailsAtStep) > 0 && {
      consecutiveFailsAtStep: count(r.consecutiveFailsAtStep),
    }),
    createdAt,
    lastUsedAt,
  };
}
