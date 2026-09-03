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
//
// The 4-tuple alone cannot see a swap that keeps the count: insert one
// look-alike above the recorded element and remove one below, and N is
// unchanged, so the index still resolves and the click lands on a stranger
// (#1182). The axis therefore carries one more field, `context` — the
// accessible name of the nearest named ancestor. It is a VERIFIER, never a
// locator: nothing is ever found by it, it can only contradict what the index
// found and stop the run. That keeps the refusal to key on position intact
// while removing the case where position lies silently.

/** An element addressed the way browser_snapshot addresses it. */
export interface RefAxis {
  kind: 'ref';
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  /** frameKeyOf(RefEntry.framePath). `''` = main frame. */
  frameKey: string;
  /**
   * The element's semantic neighbourhood at record time — `role "name"` of the
   * nearest ancestor that both carries an accessible name and has a structural
   * role (a landmark, a row, a list item, a dialog). Absent when the element
   * sat under nothing named, and absent from every trace recorded before this
   * field existed, which is what keeps the format additive.
   *
   * It is NOT a second way to FIND the element. It is only ever compared
   * against the live page's own value for the element the index picked out, so
   * a page that has been restructured under the recording stops instead of
   * clicking a look-alike (#1182). Re-resolving BY it would be the positional
   * brittleness this axis exists to avoid, one level up.
   */
  context?: string;
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
  | 'unresolved-axis'
  /**
   * The step's URL carried a credential — userinfo, or a password-family query
   * parameter. The secret is stripped before storage, which necessarily makes
   * the stored URL different from the one that worked, so the step is a hole
   * rather than a step that would replay a broken URL.
   */
  | 'redacted-url';

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
/**
 * Characters of `RefAxis.context` kept.
 *
 * Small on purpose: the context is stored on EVERY element step of every
 * trace, so it is multiplied by MAX_STEPS_PER_TRACE x
 * MAX_TRACES_PER_WORKSPACE before MAX_FILE_BYTES gets a say. 96 characters
 * holds a real section or row label (`row "Alice Chen alice@example.com"`)
 * and refuses to hold a paragraph. The truncation is applied by whoever
 * MINTS the value, so the recorded and the live string are cut the same way
 * and a long label still compares equal to itself.
 */
export const MAX_CONTEXT_CHARS = 96;

// ── Ancestor context ─────────────────────────────────────────────────────────
//
// The `context` an element carries is `role "name"` of the nearest ancestor
// that both has a structural role and is named. It is minted during the
// accessibility walk (snapshot.ts) AND the smart-snapshot walk
// (dom-intelligence.ts), and the two MUST produce the identical string: a flow
// recorded on one lane is replayed by re-resolving against the other, and a
// verifier that read `region "Checkout"` at record time but `Checkout` at
// replay would stop every replay it was meant to pass. So the role set and the
// formatting live here, in the one layer both lanes already depend on, rather
// than as two copies that drift.

/**
 * Ancestor roles whose accessible name says WHERE an element sits.
 *
 * Landmarks, table rows, list items, cards, and dialogs — the containers a
 * page names because a human needs to tell one copy of a repeated control from
 * another ("Delete" in row "Alice Chen" versus row "Bob Lee"). A `generic` or
 * an unnamed wrapper is deliberately absent: it would contribute a label that
 * changes with the markup rather than with the meaning, which is the DOM-path
 * brittleness the ref axis refuses.
 */
export const CONTEXT_ANCESTOR_ROLES: ReadonlySet<string> = new Set([
  // landmarks
  'region',
  'form',
  'search',
  'navigation',
  'main',
  'banner',
  'contentinfo',
  'complementary',
  // grouping
  'article',
  'group',
  'figure',
  'toolbar',
  'menu',
  'menubar',
  'tabpanel',
  'dialog',
  'alertdialog',
  // collections
  'list',
  'listitem',
  'table',
  'grid',
  'treegrid',
  'rowgroup',
  'row',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
]);

/**
 * The context an element's CHILDREN inherit: this node when it is a named
 * container, otherwise whatever it inherited itself. Nearest wins, so a row
 * beats the table it sits in, and an element is never its own context (the walk
 * passes the INHERITED value to the element and this value to its children).
 *
 * Truncation happens here, at the mint site, so the string a recording saves
 * and the string a replay compares it against are cut by the same rule — a
 * label clipped one way at record and another at replay would never match
 * itself.
 */
export function ancestorContext(role: string, name: string, inherited: string): string {
  if (name.length === 0 || !CONTEXT_ANCESTOR_ROLES.has(role)) return inherited;
  const label = `${role} "${name}"`;
  return label.length <= MAX_CONTEXT_CHARS ? label : `${label.slice(0, MAX_CONTEXT_CHARS - 1)}\u2026`;
}
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

/**
 * Strip the userinfo from a URL that will be STORED and later replayed.
 *
 * normalizeUrlKey drops the whole query, so it is safe for a key but useless
 * for a navigate step, which has to replay the real URL. This keeps the query
 * and removes only `user:password@`, and reports whether it had to — a URL
 * that was changed no longer replays what worked, so the caller turns the step
 * into a hole rather than storing a URL that will fail differently.
 *
 * Unparseable input is returned untouched and unflagged: there is no authority
 * to strip, and refusing here would break a `data:` or `about:` step.
 */
export function stripUrlUserinfo(url: string): { url: string; stripped: boolean } {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return { url, stripped: false };
    parsed.username = '';
    parsed.password = '';
    return { url: parsed.toString(), stripped: true };
  } catch {
    return { url, stripped: false };
  }
}

// ── Surface shape ──────────────────────────────────────────────────────────

/** The RefEntry fields an axis is built from. Structural on purpose: the
 *  recorder lives in the MCP process and must not drag snapshot.ts (and its
 *  playwright-core types) into the shared layer. */
export interface RefEntryLike {
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  frameKey: string;
  /** See RefAxis.context. Absent on a snapshot that minted no ancestor label. */
  context?: string;
}


/**
 * A hash of "what this page looks like", computed from the snapshot's own ref
 * map rather than from its rendered text.
 *
 * The ref map is the right input for two reasons. It is already in memory
 * whenever an action is recorded, so stamping a shape onto every action costs
 * no extra snapshot — which is what lets a save use the shape of the page the
 * flow STARTED on instead of the page it ended on. And it contains exactly the
 * things a trace depends on (role, name, and same-name position per frame) and
 * none of the things it does not, including the ref NUMBERS, which are minted
 * per document and change whenever the identity map is rebuilt.
 *
 * A mismatch is a WARNING, never a refusal: a page that grew a cookie banner
 * still logs in fine, and the per-step axis resolution is the real correctness
 * check.
 */
export function refMapShapeHash(entries: readonly RefEntryLike[]): string {
  const hash = createHash('sha256');
  // Sorted, so a snapshot that walks the tree in a different order (a frame
  // that attached earlier this time) does not read as a different page.
  const lines = entries
    .map((e) => `${e.frameKey ?? ''}\u0000${e.role}\u0000${e.name}\u0000${e.sameNameIndex}`)
    .sort();
  for (const line of lines) hash.update(line).update('\n');
  return hash.digest('hex');
}

// ── Axis construction ──────────────────────────────────────────────────────

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
  const context = typeof entry.context === 'string' ? entry.context.slice(0, MAX_CONTEXT_CHARS) : '';
  return {
    kind: 'ref',
    role: entry.role,
    name: typeof entry.name === 'string' ? entry.name : '',
    sameNameIndex: index,
    sameNameTotal: total,
    frameKey: typeof entry.frameKey === 'string' ? entry.frameKey : '',
    // Omitted rather than stored empty: an absent field and an empty one mean
    // the same thing (no verdict available) and the absent one costs nothing.
    ...(context.length > 0 && { context }),
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
  /**
   * The run stopped because the page changed shape under the recording, not
   * because the flow is wrong — a same-name population that grew or shrank,
   * where refusing to guess which element was the correct move.
   */
  inconclusive?: boolean;
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
  // An inconclusive stop is not evidence either way, so it moves no counter but
  // the clock. Counting it as a failure would let a page that merely sprouted a
  // second "Save" quarantine a working flow on its second try and drop it out
  // of the hint pipe for good — a permanent demotion bought by a banner.
  if (!outcome.ok && outcome.inconclusive === true) {
    return { ...trace, lastUsedAt: now };
  }
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

/**
 * A stable fingerprint of a trace's STEPS, ignoring everything else about it.
 *
 * A re-save under an existing name may be either of two things and they have
 * to be told apart: the same flow recorded again (keep its success history —
 * otherwise the serving threshold is unreachable for any flow the agent
 * repeats), or a DIFFERENT flow that reused the name (a fresh history, because
 * the old flow's successes say nothing about these steps and its quarantine
 * would unfairly condemn them).
 */
export function stepsFingerprint(steps: readonly TraceStep[]): string {
  const hash = createHash('sha256');
  for (const step of steps) {
    hash.update(step.tool).update('\u0000');
    hash.update(JSON.stringify(step.axis)).update('\u0000');
    hash.update(JSON.stringify(step.target2 ?? null)).update('\u0000');
    // Argument KEYS, not values: a login recorded with a different email is
    // the same flow. A changed value is what variables exist for.
    hash.update(Object.keys(step.args).sort().join(',')).update('\u0000');
    hash.update(step.unrecordable ?? '').update('\n');
  }
  return hash.digest('hex');
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
  'redacted-url',
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
  // A context that cannot be trusted is DROPPED, not fatal: without it the
  // step falls back to the pre-#1182 population rules, which is the same
  // contract every trace recorded before this field had.
  const context = typeof a.context === 'string' ? a.context.slice(0, MAX_CONTEXT_CHARS) : '';
  return {
    kind: 'ref',
    role: a.role,
    name,
    sameNameIndex,
    sameNameTotal,
    frameKey: typeof a.frameKey === 'string' ? a.frameKey.slice(0, 256) : '',
    ...(context.length > 0 && { context }),
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

/**
 * Sanitise one step.
 *
 * Returns null ONLY when the entry names no replayable tool — i.e. when there
 * is no step here at all. Everything else that fails to sanitise (an axis that
 * cannot be trusted, a drag target that did not survive) comes back as a HOLE
 * rather than as null, because the caller's only other option is to drop it,
 * and a trace with a step quietly missing replays a shorter, different flow
 * that still reports success. A hole refuses to run and says why.
 */
export function sanitizeTraceStep(raw: unknown): TraceStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isReplayableTool(s.tool)) return null;
  const sanitizedAxis = sanitizeAxis(s.axis);
  const axis = sanitizedAxis ?? NO_AXIS;
  const axisLost = sanitizedAxis === null;
  const target2 = s.target2 === undefined ? undefined : sanitizeAxis(s.target2);
  // A drag whose target does not survive sanitising is a hole, not a click.
  const targetLost = s.target2 !== undefined && target2 === null;
  const reason = UNRECORDABLE_REASONS.includes(s.unrecordable as UnrecordableReason)
    ? (s.unrecordable as UnrecordableReason)
    : targetLost || axisLost
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
  // Over the cap the whole record is REFUSED, not truncated. Truncating gives
  // back a trace that runs the first 30 steps of a 40-step flow and reports
  // success — a half-completed checkout is worse than no cached checkout.
  if (rawSteps.length > MAX_STEPS_PER_TRACE) return null;
  const steps: TraceStep[] = [];
  for (const entry of rawSteps) {
    const step = sanitizeTraceStep(entry);
    // A non-step (no replayable tool named) is the one thing that cannot be
    // held as a hole — there is nothing to hold. The record goes instead.
    if (!step) return null;
    steps.push(step);
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
