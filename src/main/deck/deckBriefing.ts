// ─── Command Deck — deterministic "welcome home" briefing builder ────────────
//
// The briefing PRESENTS existing judgment-engine state — it does NOT produce new
// judgment. On workspace open (and on demand) the orchestrator greets the
// operator with a one-shot summary: what changed while they were away, what is
// blocked on them, what each pane is doing, and a "look at this first" ordering.
//
// This module is PURE and transport-free (the deckPolicy.ts / renderDecisionBlock
// pattern): the handler resolves every feed (fleet snapshot, decision, mode,
// loop, the prior snapshot) and hands them in, so the builder needs no store
// access and unit-tests without IO. Never throws — a null snapshot / null entry /
// missing loop all degrade to a headline-only briefing.

import type { AgentStatus } from '../../shared/types';
import type { AgentMode } from './deckAutonomyStore';
import type { WorkspaceDecision } from './deckDecisionStore';
import type { WorkspaceLoopState } from './deckLoopStateStore';
import type { FleetSnapshot, WorkspaceListEntry } from '../workspace/WorkspaceMirror';

/** One pane in the briefing, pre-sorted by `priority` (lower = look first). */
export interface BriefingPane {
  ptyId: string;
  agentName: string | null;
  agentStatus: AgentStatus;
  cwd?: string;
  /** Sort key — the deterministic "look at this first" ladder (see PRIORITY). */
  priority: number;
  /** Machine-neutral reason token the renderer maps to copy: 'blocked' |
   *  'error' | 'finished' | 'running' | 'idle'. */
  reason: BriefingReason;
}

export type BriefingReason = 'blocked' | 'error' | 'finished' | 'running' | 'idle';

/** The delta versus the last-viewed snapshot (§ "changed while away"). null when
 *  there is no prior snapshot (first-ever view) — the card then renders
 *  headline-only, with NO "everything is new" delta line. */
export interface BriefingChange {
  /** ptyIds that newly became complete since the last view. */
  finished: string[];
  /** ptyIds that newly became awaiting_input/waiting since the last view. */
  newlyBlocked: string[];
  /** ptyIds that newly became error since the last view. */
  errored: string[];
  /** A pending decision was raised (or replaced) since the last view. */
  newDecision: boolean;
}

/** The headline as STRUCTURED counts, never as prose. The main process does not
 *  know the operator's language, so it ships numbers and the renderer composes
 *  the sentence from whole-sentence i18n keys (English pluralization must not be
 *  baked into main). */
export interface BriefingCounts {
  total: number;
  blocked: number;
  errored: number;
  running: number;
  done: number;
  idle: number;
}

export interface WorkspaceBriefing {
  workspaceId: string;
  workspaceName: string;
  mode: AgentMode;
  /** Deterministic headline inputs (summarizeBriefingCounts). */
  counts: BriefingCounts;
  /** The #568 "blocked on you" — a POINTER only; the DeckDecisionCard owns the
   *  resolve UI, so the briefing never renders a second control for it. */
  pendingDecision: WorkspaceDecision | null;
  /** The running loop's objective + how many done-when tasks pass. */
  loop: { objective: string; passes: number; taskCount: number } | null;
  /** The ptyIds that are blocked RIGHT NOW (awaiting_input / waiting), capped.
   *  This is CURRENT state, not a delta: it is the card's rising-edge input, and
   *  a rising edge is "blocked in this observation, not in the previous one".
   *  Deriving it from `changed.newlyBlocked` mixed two clocks — that field is
   *  diffed against the persisted last-ACKED baseline, so a pane that was
   *  created already blocked never appeared in it, and a re-block after an
   *  unacknowledged recovery never read as new. See `briefingSignal`. */
  blockedPtyIds: string[];
  /** The TOP of the priority ladder — the single "look at this first" pane, and
   *  the only pane the card names. Owner decision 2026-07-24: the briefing does
   *  NOT render a pane roster; DeckFleet is mounted directly above it with a
   *  near-identical row anatomy, and a blocked pane was being rendered three
   *  times across the screen (Fleet row + briefing row + titlebar vitals chip)
   *  where DESIGN.md allows two — "Never three." The full sorted list is still
   *  computed (it feeds the counts and this pick) but is not shipped. */
  topPane: BriefingPane | null;
  changed: BriefingChange | null;
  coldStart: boolean;
  builtAt: number;
}

/** The tiny status-only snapshot persisted after each view, diffed on the next
 *  open so the delta is "what changed since YOU last saw it", not "since main
 *  last pushed". Kept status-only (ptyId→status + decisionId) so the file stays
 *  small even at 30+ sessions. */
export interface BriefedSnapshot {
  panes: { ptyId: string; agentStatus: AgentStatus }[];
  /** The pending decision id at view time, or null. */
  decisionId: string | null;
  at: number;
}

/** The deterministic "look at this first" ladder. A workspace-level pending
 *  decision is rendered ABOVE the pane list (it is not a pane), so the pane
 *  priorities start at awaiting_input. */
const PRIORITY: Record<AgentStatus, number> = {
  awaiting_input: 1,
  waiting: 1,
  error: 2,
  complete: 3,
  running: 4,
  idle: 5,
};

/** Caps on the free-form strings that ride the briefing payload. `cwd` is
 *  OSC 7-influenced (issue #540) and `agentName` / `loop.objective` are
 *  operator/agent text — React escapes them and the briefing never enters an LLM
 *  prompt, so this is consistency with the other deck payload caps rather than a
 *  live exploit fix. */
export const BRIEFING_LIMITS = {
  MAX_AGENT_NAME_CHARS: 80,
  MAX_CWD_CHARS: 200,
  MAX_OBJECTIVE_CHARS: 200,
  /** Bound on `blockedPtyIds`. The list is taken off the priority-sorted panes
   *  (blocked first, ties by ptyId), so the cap is deterministic rather than
   *  arbitrary — and a fleet with more than this many simultaneously blocked
   *  panes has bigger problems than a missed auto-expand. */
  MAX_BLOCKED_IDS: 64,
} as const;

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The mirror rows that are actually AGENTS. `buildFleetSnapshots` emits one row
 * per leaf even when the leaf has no PTY, so the raw snapshot also carries
 * unspawned leaves and browser/editor/diff surfaces — all of which are created
 * with `ptyId: ''` (surfaceSlice.ts addBrowserSurface / addEditorSurface /
 * addDiffSurface / addWorkspaceDiffSurface). An empty ptyId is therefore an
 * exact proxy for "not a live terminal" here, which is why this filters on that
 * alone rather than plumbing `surfaceType` through the mirror payload: the
 * cheap test is equivalent to DeckFleet's `ptyId !== '' && surfaceType ===
 * 'terminal'` (DeckFleet.tsx), and widening the shared FleetSnapshotPane wire
 * shape would also touch the heartbeat's `[fleet-snapshot]` consumer for no
 * additional coverage.
 *
 * Without this a workspace holding only an empty leaf briefed as "The agent is
 * idle." — the dead-chrome failure DESIGN.md forbids — and browser panes
 * inflated every count.
 */
function agentPanes(snapshot: FleetSnapshot | null): FleetSnapshot['panes'] {
  return (snapshot?.panes ?? []).filter((p) => p.ptyId !== '');
}

function reasonFor(status: AgentStatus): BriefingReason {
  switch (status) {
    case 'awaiting_input':
    case 'waiting':
      return 'blocked';
    case 'error':
      return 'error';
    case 'complete':
      return 'finished';
    case 'running':
      return 'running';
    case 'idle':
    default:
      return 'idle';
  }
}

export interface BuildBriefingInputs {
  workspaceId: string;
  /** The workspace list entry (for its name). null when the mirror hasn't been
   *  populated yet — the briefing falls back to the id. */
  entry: WorkspaceListEntry | null;
  /** The per-workspace fleet snapshot. null / empty ⇒ headline-only. */
  snapshot: FleetSnapshot | null;
  decision: WorkspaceDecision | null;
  mode: AgentMode;
  loop: WorkspaceLoopState | null;
  /** The last-viewed snapshot for the delta, or null for a first-ever view. */
  prior: BriefedSnapshot | null;
  coldStart: boolean;
  /** Injectable clock (builtAt) so tests are deterministic. */
  now?: number;
}

/**
 * Build the deterministic briefing from already-resolved feeds. Pure,
 * never-throws — every input may be null/empty and the result still renders.
 */
/**
 * The panes of a fleet snapshot, mapped + sorted by the priority ladder. Pure
 * and exported for testing: the ladder still decides which single pane the card
 * names ("look at this first"), even though the list itself is no longer
 * rendered as rows.
 */
export function buildBriefingPanes(snapshot: FleetSnapshot | null): BriefingPane[] {
  return agentPanes(snapshot)
    .map((p) => ({
      ptyId: p.ptyId,
      agentName: p.agentName ? cap(p.agentName, BRIEFING_LIMITS.MAX_AGENT_NAME_CHARS) : p.agentName,
      agentStatus: p.agentStatus,
      ...(p.cwd ? { cwd: cap(p.cwd, BRIEFING_LIMITS.MAX_CWD_CHARS) } : {}),
      priority: PRIORITY[p.agentStatus] ?? 5,
      reason: reasonFor(p.agentStatus),
    }))
    // Stable sort by priority, then by ptyId so equal-priority panes never
    // reorder between builds — the named "look at this first" pane must not
    // flicker between two equally-urgent candidates on consecutive refreshes.
    .sort((a, b) => a.priority - b.priority || a.ptyId.localeCompare(b.ptyId));
}

export function buildWorkspaceBriefing(inputs: BuildBriefingInputs): WorkspaceBriefing {
  const { workspaceId, entry, snapshot, decision, mode, loop, prior, coldStart } = inputs;
  const builtAt = inputs.now ?? Date.now();

  const pendingDecision = decision && decision.status === 'pending' ? decision : null;

  const rawPanes = agentPanes(snapshot);
  const panes = buildBriefingPanes(snapshot);

  const loopSummary =
    loop && loop.objective
      ? {
          objective: cap(loop.objective, BRIEFING_LIMITS.MAX_OBJECTIVE_CHARS),
          passes: loop.tasks.filter((t) => t.passes).length,
          taskCount: loop.tasks.length,
        }
      : null;

  const changed = computeChange(rawPanes, pendingDecision, prior);

  return {
    workspaceId,
    workspaceName: entry?.name || workspaceId,
    mode,
    counts: summarizeBriefingCounts(panes),
    pendingDecision,
    loop: loopSummary,
    // Sorted blocked-first with ptyId tie-breaks, so the cap takes a stable
    // prefix rather than whichever panes the mirror happened to emit first.
    blockedPtyIds: panes
      .filter((p) => p.reason === 'blocked')
      .slice(0, BRIEFING_LIMITS.MAX_BLOCKED_IDS)
      .map((p) => p.ptyId),
    topPane: panes[0] ?? null,
    changed,
    coldStart,
    builtAt,
  };
}

/**
 * Delta vs the last-viewed snapshot. null prior (first-ever view) ⇒ null (no
 * "everything is new" spam — locked owner decision). A pane present now but
 * absent from the prior snapshot is NOT counted as a transition (it never had a
 * prior status to change FROM) — only a status that actually crossed into
 * complete / awaiting_input / error since the last view counts.
 */
function computeChange(
  currentPanes: FleetSnapshot['panes'],
  pendingDecision: WorkspaceDecision | null,
  prior: BriefedSnapshot | null,
): BriefingChange | null {
  if (!prior) return null;
  const priorStatus = new Map(prior.panes.map((p) => [p.ptyId, p.agentStatus]));
  const finished: string[] = [];
  const newlyBlocked: string[] = [];
  const errored: string[] = [];
  // One transition per pane: a ptyId repeated in the snapshot must not read as
  // "2 finished" for a single pane.
  const counted = new Set<string>();
  for (const p of currentPanes) {
    if (counted.has(p.ptyId)) continue;
    counted.add(p.ptyId);
    const before = priorStatus.get(p.ptyId);
    if (before === undefined) continue; // new pane — no transition to report
    if (p.agentStatus === 'complete' && before !== 'complete') finished.push(p.ptyId);
    else if (
      (p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting') &&
      before !== 'awaiting_input' &&
      before !== 'waiting'
    ) {
      newlyBlocked.push(p.ptyId);
    } else if (p.agentStatus === 'error' && before !== 'error') errored.push(p.ptyId);
  }
  // A decision is "new" when there is a pending one whose id differs from the id
  // recorded at the last view (a fresh raise, or a replacement of an old one).
  const newDecision = pendingDecision != null && pendingDecision.id !== prior.decisionId;
  return { finished, newlyBlocked, errored, newDecision };
}

/**
 * The deterministic headline inputs: how many panes sit in each reason bucket.
 * Numbers only — the renderer turns them into a sentence with whole-sentence
 * i18n keys, because main has no locale and English pluralization ("1 needs you"
 * vs "2 need you") must not be hard-coded here. Pure + exported for unit testing.
 */
export function summarizeBriefingCounts(panes: readonly BriefingPane[]): BriefingCounts {
  const counts: BriefingCounts = {
    total: panes.length,
    blocked: 0,
    errored: 0,
    running: 0,
    done: 0,
    idle: 0,
  };
  for (const p of panes) {
    if (p.reason === 'running') counts.running += 1;
    else if (p.reason === 'blocked') counts.blocked += 1;
    else if (p.reason === 'finished') counts.done += 1;
    else if (p.reason === 'error') counts.errored += 1;
    else counts.idle += 1;
  }
  return counts;
}

/** Whether the delta carries anything worth a "changed while away" line. */
export function hasBriefingDelta(changed: BriefingChange | null): boolean {
  if (!changed) return false;
  return (
    changed.finished.length > 0 ||
    changed.newlyBlocked.length > 0 ||
    changed.errored.length > 0 ||
    changed.newDecision
  );
}

/**
 * Whether this briefing has anything worth rendering at all. An empty workspace
 * with no decision, no loop and no delta has NOTHING to say, and DESIGN.md is
 * explicit that a surface with nothing to report must not render (the always-on
 * instrument strip was removed the day it landed — "no dead gauges, no extra
 * chrome row"). The sibling DeckFleet applies the same rule.
 */
export function briefingHasContent(b: WorkspaceBriefing): boolean {
  return (
    b.counts.total > 0 ||
    b.pendingDecision !== null ||
    b.loop !== null ||
    hasBriefingDelta(b.changed)
  );
}

/**
 * Whether the card should auto-expand rather than sit as a collapsed one-line
 * affordance. Locked owner decision: expand ONLY on cold start, a newly-raised
 * decision, or a newly-blocked pane — a plain "finished" stays collapsed so the
 * card never nags on every workspace switch. A cold start with NOTHING to report
 * does not expand either: opening an empty container is the dead-chrome failure.
 */
export function shouldAutoExpandBriefing(b: WorkspaceBriefing): boolean {
  if (!briefingHasContent(b)) return false;
  if (b.coldStart) return true;
  if (!b.changed) return false;
  return b.changed.newDecision || b.changed.newlyBlocked.length > 0;
}

/**
 * The actionable-state fingerprint the card diffs between refreshes. Both
 * fields are CURRENT state at build time — the rising edge is computed by the
 * card from two consecutive observations, never from the persisted delta.
 */
export interface BriefingSignal {
  decisionId: string | null;
  blocked: readonly string[];
}

export function briefingSignal(b: WorkspaceBriefing): BriefingSignal {
  return {
    decisionId: b.pendingDecision?.id ?? null,
    blocked: b.blockedPtyIds,
  };
}

/**
 * Did something NEW become actionable between two refreshes — a decision that
 * just appeared, or a pane that just became blocked? The card auto-expands on a
 * rising edge only; a background refresh that merely re-reports the same blocked
 * pane must leave the operator's expand/collapse alone (the card fought the user
 * when every 200ms stream tick re-applied the auto-expand rule).
 *
 * `prev`/`next` are two CONSECUTIVE LIVE observations. That is the whole reason
 * `blocked` is current state rather than `changed.newlyBlocked`: the delta is
 * measured against the last ACKED baseline, which only moves when the operator
 * actually sees the card, so a pane that recovered and blocked again — or one
 * that spawned already blocked — never produced an edge here.
 */
export function isNewlyActionable(prev: BriefingSignal | null, next: BriefingSignal): boolean {
  if (!prev) return false; // first observation — the hydration path owns that decision
  if (next.decisionId !== null && next.decisionId !== prev.decisionId) return true;
  return next.blocked.some((ptyId) => !prev.blocked.includes(ptyId));
}

/**
 * Distil a fleet snapshot into the tiny status-only record to persist once the
 * operator has actually seen a briefing (the next open diffs against this).
 *
 * Takes the RAW snapshot rather than the built briefing: the briefing no longer
 * carries a pane list (only the top-priority pick), but the delta baseline needs
 * every pane's status. The handler already holds the raw snapshot, so this reads
 * from the source instead of round-tripping through a payload field that exists
 * only to feed it.
 *
 * Filtered + deduped by the same rule the briefing counts use, so the baseline
 * can never disagree with the panes the operator was actually shown.
 */
export function toBriefedSnapshot(
  snapshot: FleetSnapshot | null,
  decisionId: string | null,
  at: number,
): BriefedSnapshot {
  const seen = new Set<string>();
  const panes: BriefedSnapshot['panes'] = [];
  for (const p of agentPanes(snapshot)) {
    if (seen.has(p.ptyId)) continue;
    seen.add(p.ptyId);
    panes.push({ ptyId: p.ptyId, agentStatus: p.agentStatus });
  }
  return { panes, decisionId, at };
}
