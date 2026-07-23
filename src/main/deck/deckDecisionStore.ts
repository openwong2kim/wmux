// ─── Command Deck — durable decision gate (M1) ──────────────────────────────
//
// A brain-raised, restart-surviving "I need a human decision" checkpoint. The
// orchestrator brain calls the MCP tool `deck_ask_decision` (→ pipe RPC
// `deck.requestDecision`) when it hits a fork only a human should settle; the
// pending decision is persisted here and BLOCKS that workspace's auto-wake loop
// (CommanderEventCoalescer / DeckScheduler consult `hasPendingDecision`) until a
// human resolves it in the Deck UI (ipcMain `deck:decision:resolve`). On resolve
// the brain resumes with the resolution injected into its next turn
// (`withLoopContext` → `renderDecisionBlock`).
//
// Because it is an atomic JSON file in the wmux data dir — the exact pattern of
// deck-loop-state.json — it survives an app close / reboot for FREE: no extra
// reboot code, consulted fresh on the first post-restart flush/tick.
//
// This is NOT a cage on the brain: the brain CHOOSES to pause (its own
// judgment). It is deliberately distinct from MCP plugin-trust approval
// (ApprovalQueue), the pane-agent `approvalPress` pre-authorization, and the
// human-initiated loop `paused` state — do not conflate.
//
// Storage: one JSON file (`deck-decisions.json`) in the wmux data dir, atomic
// write, WMUX_DATA_SUFFIX-isolated, keyed by workspaceId (at most one active
// decision per workspace). Read-modify-write per mutation against the CURRENT
// file so a concurrent edit isn't clobbered by a stale in-memory copy. Never
// throws — a torn store must never brick the wake loop.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import type { AgentMode } from './deckAutonomyStore';

export type DecisionStatus = 'pending' | 'resolved';

export interface WorkspaceDecision {
  /** Stable id returned to the brain and echoed by the human's resolve. */
  id: string;
  /** The decision the brain needs a human to settle. */
  question: string;
  /** Optional discrete choices; empty ⇒ free-text answer. */
  options: string[];
  /** Optional short "what's at stake" the brain supplies. */
  context: string;
  status: DecisionStatus;
  /** The human's answer (a chosen option or free text). Present once resolved. */
  resolution?: string;
  /** Who resolved it (3-way review round 2): 'human' via the Deck UI, 'brain'
   *  via the auto-mode self-resolve RPC. Consumers use this to decide whether a
   *  resolution may be consumed by the re-examine turn (brain's own) or must
   *  survive to the next resume turn (the human's answer — never droppable).
   *  Absent on legacy records ⇒ treated as 'human' (the conservative read). */
  resolvedBy?: DecisionResolvedBy;
  raisedAt: number;
  resolvedAt?: number;
}

export type DecisionResolvedBy = 'human' | 'brain';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export const DECISION_LIMITS = {
  MAX_QUESTION_CHARS: 1000,
  MAX_OPTIONS: 6,
  MAX_OPTION_CHARS: 200,
  MAX_CONTEXT_CHARS: 800,
  MAX_RESOLUTION_CHARS: 1000,
} as const;

export function getDeckDecisionPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-decisions.json');
}

/** options 정규화 — 문자열만, trim, 빈 항목 제거, 개수·길이 캡. */
function sanitizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, DECISION_LIMITS.MAX_OPTIONS)
    .map((s) => s.slice(0, DECISION_LIMITS.MAX_OPTION_CHARS));
}

function sanitizeDecision(raw: unknown): WorkspaceDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const question = typeof o.question === 'string' ? o.question.trim() : '';
  if (!question) return null; // a decision with no question is not a decision
  const resolution =
    typeof o.resolution === 'string' && o.resolution.trim().length > 0
      ? o.resolution.trim().slice(0, DECISION_LIMITS.MAX_RESOLUTION_CHARS)
      : undefined;
  // Fail-closed: a 'resolved' record that lost its resolution is incoherent →
  // load it back as still-pending so the loop stays blocked, not silently freed.
  const status: DecisionStatus = o.status === 'resolved' && resolution ? 'resolved' : 'pending';
  return {
    id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
    question: question.slice(0, DECISION_LIMITS.MAX_QUESTION_CHARS),
    options: sanitizeOptions(o.options),
    context:
      typeof o.context === 'string' ? o.context.slice(0, DECISION_LIMITS.MAX_CONTEXT_CHARS) : '',
    status,
    ...(status === 'resolved' && resolution ? { resolution } : {}),
    ...(status === 'resolved' && (o.resolvedBy === 'human' || o.resolvedBy === 'brain')
      ? { resolvedBy: o.resolvedBy as DecisionResolvedBy }
      : {}),
    raisedAt: typeof o.raisedAt === 'number' && Number.isFinite(o.raisedAt) ? o.raisedAt : 0,
    ...(typeof o.resolvedAt === 'number' && Number.isFinite(o.resolvedAt)
      ? { resolvedAt: o.resolvedAt }
      : {}),
  };
}

type DecisionFile = Record<string, WorkspaceDecision>;

// Single-writer serialization. loadDeckDecisions (sync read) → compute →
// `await atomicWriteJSON` has an async boundary, so two concurrent mutate calls
// could each read the same snapshot and the later write would clobber the
// earlier one — silently dropping a pending/resolved decision (3-way review
// P1). Chaining every mutate through one promise makes read-modify-write
// atomic per process. Decisions are low-frequency, so the serialization cost is
// negligible.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  // Keep the chain alive even if a write rejects (never wedge future mutates).
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Load the whole map; a missing/corrupt file is an empty map (fail open — a
 *  torn store must never brick the deck). Bad keys/entries dropped. */
export function loadDeckDecisions(dir?: string): DecisionFile {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getDeckDecisionPath(dir));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: DecisionFile = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!WORKSPACE_ID_RE.test(k)) continue;
    const d = sanitizeDecision(v);
    if (d) out[k] = d;
  }
  return out;
}

/** Resolve one workspace's decision, or null when none. Never throws. */
export function loadWorkspaceDecision(workspaceId: string, dir?: string): WorkspaceDecision | null {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  try {
    return loadDeckDecisions(dir)[workspaceId] ?? null;
  } catch {
    return null;
  }
}

/** The wake-suppression predicate: a workspace with a PENDING decision must not
 *  be auto-woken. Never throws (a torn store reads as "no pending decision" —
 *  fail open so a corrupt file can't wedge every wake). */
export function hasPendingDecision(workspaceId: string, dir?: string): boolean {
  const d = loadWorkspaceDecision(workspaceId, dir);
  return d !== null && d.status === 'pending';
}

function mutate(
  workspaceId: string,
  fn: (prev: WorkspaceDecision | null) => WorkspaceDecision | null,
  dir?: string,
): Promise<WorkspaceDecision | null> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return Promise.resolve(null);
  // Serialized: the load + compute + write runs to completion before the next
  // mutate begins, so a concurrent raise/resolve/clear cannot read a stale
  // snapshot and clobber the other's write.
  return serialize(async () => {
    const all = loadDeckDecisions(dir);
    const next = fn(all[workspaceId] ?? null);
    if (next === null) {
      delete all[workspaceId];
    } else {
      all[workspaceId] = next;
    }
    await atomicWriteJSON(getDeckDecisionPath(dir), all);
    return next;
  });
}

/** Raise (or replace) a workspace's pending decision. Callers should reject a
 *  second raise while one is already pending (RPC layer) so the brain can't
 *  stack decisions; this store itself is last-writer-wins. */
export async function raiseDecision(
  workspaceId: string,
  args: { question: string; options?: string[]; context?: string },
  dir?: string,
): Promise<WorkspaceDecision | null> {
  const question = args.question.trim();
  if (!question) return null;
  return mutate(
    workspaceId,
    () => ({
      id: randomUUID(),
      question: question.slice(0, DECISION_LIMITS.MAX_QUESTION_CHARS),
      options: sanitizeOptions(args.options),
      context:
        typeof args.context === 'string'
          ? args.context.trim().slice(0, DECISION_LIMITS.MAX_CONTEXT_CHARS)
          : '',
      status: 'pending',
      raisedAt: Date.now(),
    }),
    dir,
  );
}

/**
 * REPLACE a STALE pending decision with a sharper question — compare-and-swap
 * inside ONE serialized mutation (3-way review round 2): the existing record
 * must still be the expected id, still pending, and still stale under `ttlMs`
 * AT WRITE TIME. Without this, a load→check→raise sequence races the human's
 * resolve: their answer lands between the check and the raise, and the raise
 * (last-writer-wins) silently overwrites the RESOLVED record with a fresh
 * pending one — discarding the human's answer. Returns the new pending decision,
 * or null when the CAS failed (caller should treat it as "no replace happened";
 * the human's resolution, if that is what won, stays intact on disk).
 */
export async function replaceStaleDecision(
  workspaceId: string,
  expectedId: string,
  ttlMs: number,
  args: { question: string; options?: string[]; context?: string },
  dir?: string,
): Promise<WorkspaceDecision | null> {
  const question = args.question.trim();
  if (!question || !expectedId) return null;
  let swapped = false;
  const result = await mutate(
    workspaceId,
    (prev) => {
      if (
        !prev ||
        prev.status !== 'pending' ||
        prev.id !== expectedId ||
        !isDecisionStale(prev, ttlMs)
      ) {
        return prev; // CAS failed — leave whatever is there (incl. a human resolve) intact
      }
      swapped = true;
      return {
        id: randomUUID(),
        question: question.slice(0, DECISION_LIMITS.MAX_QUESTION_CHARS),
        options: sanitizeOptions(args.options),
        context:
          typeof args.context === 'string'
            ? args.context.trim().slice(0, DECISION_LIMITS.MAX_CONTEXT_CHARS)
            : '',
        status: 'pending',
        raisedAt: Date.now(),
      };
    },
    dir,
  );
  return swapped ? result : null;
}

/** Resolve a pending decision, but ONLY when the id matches the active one and
 *  it is still pending (a stale resolve — wrong id, already resolved, or empty
 *  answer — is a no-op returning current state). */
export async function resolveDecision(
  workspaceId: string,
  id: string,
  resolution: string,
  dir?: string,
  resolvedBy: DecisionResolvedBy = 'human',
): Promise<WorkspaceDecision | null> {
  const answer = resolution.trim();
  if (!answer) return null;
  // Fast no-op WITHOUT a disk write for a stale resolve (wrong id / already
  // resolved / no decision); the serialized mutate below re-checks
  // authoritatively under the write lock for the concurrent case.
  const cur = loadWorkspaceDecision(workspaceId, dir);
  if (!cur || cur.id !== id || cur.status !== 'pending') return null;
  let transitioned = false;
  const result = await mutate(
    workspaceId,
    (prev) => {
      // Resolve ONLY a still-pending decision whose id matches. A stale resolve
      // (wrong id, already resolved, or a rapid second click) is a no-op — it
      // returns the record unchanged and, via `transitioned`, tells the caller
      // NOT to kick a duplicate resume turn (3-way review: double-resume).
      if (!prev || prev.id !== id || prev.status !== 'pending') return prev;
      transitioned = true;
      return {
        ...prev,
        status: 'resolved',
        resolution: answer.slice(0, DECISION_LIMITS.MAX_RESOLUTION_CHARS),
        resolvedBy,
        resolvedAt: Date.now(),
      };
    },
    dir,
  );
  return transitioned ? result : null;
}

/** Remove a workspace's decision entirely (called when its loop is cleared, or
 *  as a hard reset). */
export async function clearDecision(workspaceId: string, dir?: string): Promise<void> {
  await mutate(workspaceId, () => null, dir);
}

/** Consume-once: drop a decision ONLY if it is already resolved (its resolution
 *  has ridden a turn via `renderDecisionBlock`). A pending decision is left
 *  intact — it must keep blocking.
 *
 *  Consume ONLY the resolved decision identified by `expectedId` (the one THIS
 *  turn actually injected). Without that scoping, the very turn that RAISED a
 *  decision would, on completion, delete a resolution created mid-turn that it
 *  never carried — silently dropping the human's answer and unblocking the loop
 *  (3-way review P1). A `null`/omitted expectedId clears any resolved decision
 *  (unscoped) — used only where no specific turn owns the consume.
 *
 *  Reads first and writes only when there is actually a matching resolved
 *  decision to clear — this may run after a turn, and the common path (nothing
 *  to clear) must never touch disk. */
export async function clearResolvedDecision(
  workspaceId: string,
  expectedId?: string,
  dir?: string,
): Promise<void> {
  const cur = loadWorkspaceDecision(workspaceId, dir);
  if (!cur || cur.status !== 'resolved') return;
  if (expectedId !== undefined && cur.id !== expectedId) return;
  await mutate(
    workspaceId,
    (prev) =>
      prev && prev.status === 'resolved' && (expectedId === undefined || prev.id === expectedId)
        ? null
        : prev,
    dir,
  );
}

/**
 * Render the decision as a compact block prepended to the brain's turn (the
 * `withLoopContext` seam). Trusted context (the brain's own decision), NOT the
 * untrusted pane-events block. Pending ⇒ "you are blocked"; resolved ⇒ "the
 * human decided X, continue".
 */
export function renderDecisionBlock(d: WorkspaceDecision): string {
  if (d.status === 'resolved') {
    // Provenance-aware (round-3 review P2): a brain self-resolution must never
    // be presented as the human's answer — a stranded self-resolve that resumes
    // later (turn errored after the resolve landed) says so honestly.
    if (d.resolvedBy === 'brain') {
      return [
        `[decision] RESOLVED (self) — you resolved this stale decision YOURSELF: ${d.question}`,
        `your resolution: ${d.resolution ?? ''}`,
        'This is your OWN auto-mode self-resolution, not a human answer. If it still',
        'holds, act on it and continue; if it no longer applies, raise a fresh decision.',
      ].join('\n');
    }
    return [
      `[decision] RESOLVED — you asked the human: ${d.question}`,
      `the human decided: ${d.resolution ?? ''}`,
      'Act on this decision and continue.',
    ].join('\n');
  }
  const parts = [
    '[decision] BLOCKED — you are waiting on a human decision and must NOT proceed:',
    `  ${d.question}`,
  ];
  if (d.options.length > 0) parts.push(`  options: ${d.options.join(' | ')}`);
  if (d.context) parts.push(`  context: ${d.context}`);
  parts.push(
    'Do not act until the human resolves this. If they just messaged you, they may be answering — otherwise wait.',
  );
  return parts.join('\n');
}

/**
 * Is this PENDING decision STALE — has it sat unanswered longer than `ttlMs`?
 * Pure and clock-injectable (WP3 heartbeat re-examine gate). A resolved decision
 * is never stale (there is nothing to re-examine); a decision with a
 * missing/zero raisedAt (0, the sanitize fallback) counts its age from the epoch
 * and so reads as stale immediately — the conservative choice, since a pending
 * decision with no timestamp has been around long enough that we lost its clock.
 */
export function isDecisionStale(
  d: WorkspaceDecision,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (d.status !== 'pending') return false;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return now - d.raisedAt > ttlMs;
}

/**
 * Render the STALE re-examine variant of a pending decision block (WP3). Unlike
 * renderDecisionBlock's plain "BLOCKED — wait" pending text, this tells the brain
 * the decision has gone unanswered for N+ minutes and it must re-examine NOW:
 *
 *   - in `auto` mode, if a BINDING policy rule / standing convention settles the
 *     question, it may resolve its OWN decision via deck_resolve_decision({id,
 *     resolution}) — citing that rule — and proceed;
 *   - in any mode it may instead re-raise a sharper question (deck_ask_decision,
 *     which replaces this one) or keep waiting;
 *   - under assist/off it may NOT self-resolve (server-enforced) — restate/improve
 *     only.
 *
 * Trusted context (the brain's own decision), prepended to the re-examine turn.
 * Kept SEPARATE from renderDecisionBlock so that function's output stays
 * byte-identical for its existing callers (withLoopContext, the UI hydrate).
 */
export function renderStaleDecisionBlock(
  d: WorkspaceDecision,
  opts: { ttlMinutes: number; mode: AgentMode },
): string {
  const mins = Math.max(1, Math.round(opts.ttlMinutes));
  const parts = [
    `[decision] STALE — this decision you raised has been PENDING for ${mins}+ minutes ` +
      'with no human answer. Re-examine it NOW:',
    `  ${d.question}`,
  ];
  if (d.options.length > 0) parts.push(`  options: ${d.options.join(' | ')}`);
  if (d.context) parts.push(`  context: ${d.context}`);
  parts.push(`  id: ${d.id}`);
  if (opts.mode === 'auto') {
    parts.push(
      'You are in AUTO mode. If a BINDING policy rule or a standing convention actually ' +
        'settles this question, resolve it YOURSELF: call ' +
        'deck_resolve_decision({ id, resolution }) with the resolution STATING the rule/basis ' +
        'that settles it, then act on it and proceed. EXCEPTION: if this decision concerns a ' +
        'risky or irreversible action (destructive commands, force-push, deploys, deletions), ' +
        'self-resolve is NOT for it — that class always waits for the human, no matter how ' +
        'stale. If NOTHING settles it, either re-raise a ' +
        'sharper question with deck_ask_decision (which replaces this one) or keep waiting — do ' +
        'NOT invent an answer just to unblock yourself.',
    );
  } else {
    parts.push(
      'You may NOT resolve this yourself in this mode — only the human can. Either re-raise a ' +
        'sharper, better-framed question with deck_ask_decision (which replaces this one) so the ' +
        'human has what they need, or keep waiting. Do not act on the question until it is resolved.',
    );
  }
  return parts.join('\n');
}
