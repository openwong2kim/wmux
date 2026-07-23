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
// missing loop all degrade to a greeting-only briefing.

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
 *  greeting-only, with NO "everything is new" delta line. */
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

export interface WorkspaceBriefing {
  workspaceId: string;
  workspaceName: string;
  mode: AgentMode;
  /** Deterministic one-line headline (renderBriefingGreeting). */
  greeting: string;
  /** The #568 "blocked on you" — a POINTER only; the DeckDecisionCard owns the
   *  resolve UI, so the briefing never renders a second control for it. */
  pendingDecision: WorkspaceDecision | null;
  /** The running loop's objective + how many done-when tasks pass. */
  loop: { objective: string; passes: number; taskCount: number } | null;
  panes: BriefingPane[];
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
  /** The per-workspace fleet snapshot. null / empty ⇒ greeting-only. */
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
export function buildWorkspaceBriefing(inputs: BuildBriefingInputs): WorkspaceBriefing {
  const { workspaceId, entry, snapshot, decision, mode, loop, prior, coldStart } = inputs;
  const builtAt = inputs.now ?? Date.now();

  const pendingDecision = decision && decision.status === 'pending' ? decision : null;

  const rawPanes = snapshot?.panes ?? [];
  const panes: BriefingPane[] = rawPanes
    .map((p) => ({
      ptyId: p.ptyId,
      agentName: p.agentName,
      agentStatus: p.agentStatus,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      priority: PRIORITY[p.agentStatus] ?? 5,
      reason: reasonFor(p.agentStatus),
    }))
    // Stable sort by priority, then by ptyId so equal-priority rows never
    // reorder between builds (deterministic ordering for the "+N more" cap).
    .sort((a, b) => a.priority - b.priority || a.ptyId.localeCompare(b.ptyId));

  const loopSummary =
    loop && loop.objective
      ? {
          objective: loop.objective,
          passes: loop.tasks.filter((t) => t.passes).length,
          taskCount: loop.tasks.length,
        }
      : null;

  const changed = computeChange(rawPanes, pendingDecision, prior);

  const briefing: WorkspaceBriefing = {
    workspaceId,
    workspaceName: entry?.name || workspaceId,
    mode,
    greeting: '',
    pendingDecision,
    loop: loopSummary,
    panes,
    changed,
    coldStart,
    builtAt,
  };
  briefing.greeting = renderBriefingGreeting(briefing);
  return briefing;
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
  for (const p of currentPanes) {
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
 * The deterministic one-line headline. `coldStart` gets the fuller "Welcome
 * back" treatment; a manual re-brief stays terse. Composed from CURRENT fleet
 * composition (the "changed while away" delta line is rendered separately by the
 * card). Pure + exported for unit testing.
 */
export function renderBriefingGreeting(b: WorkspaceBriefing): string {
  const prefix = b.coldStart ? 'Welcome back. ' : '';
  if (b.panes.length === 0) {
    if (b.pendingDecision) return `${prefix}One decision is waiting on you.`.trim();
    return `${prefix}Nothing running here yet.`.trim();
  }
  let running = 0;
  let blocked = 0;
  let done = 0;
  let errored = 0;
  for (const p of b.panes) {
    if (p.reason === 'running') running += 1;
    else if (p.reason === 'blocked') blocked += 1;
    else if (p.reason === 'finished') done += 1;
    else if (p.reason === 'error') errored += 1;
  }
  const clauses: string[] = [];
  if (blocked > 0) clauses.push(`${blocked} need${blocked === 1 ? 's' : ''} you`);
  if (errored > 0) clauses.push(`${errored} in error`);
  if (running > 0) clauses.push(`${running} running`);
  if (done > 0) clauses.push(`${done} finished`);
  if (clauses.length === 0) {
    const n = b.panes.length;
    return `${prefix}${n === 1 ? 'The agent is idle' : `All ${n} agents are idle`}.`.trim();
  }
  return `${prefix}${clauses.join(', ')}.`.trim();
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
 * Whether the card should auto-expand rather than sit as a collapsed one-line
 * affordance. Locked owner decision: expand ONLY on cold start, a newly-raised
 * decision, or a newly-blocked pane — a plain "finished" stays collapsed so the
 * card never nags on every workspace switch.
 */
export function shouldAutoExpandBriefing(b: WorkspaceBriefing): boolean {
  if (b.coldStart) return true;
  if (!b.changed) return false;
  return b.changed.newDecision || b.changed.newlyBlocked.length > 0;
}

/** Distil a built briefing into the tiny status-only snapshot to persist after a
 *  view (the next open diffs against this). */
export function toBriefedSnapshot(b: WorkspaceBriefing, at?: number): BriefedSnapshot {
  return {
    panes: b.panes.map((p) => ({ ptyId: p.ptyId, agentStatus: p.agentStatus })),
    decisionId: b.pendingDecision?.id ?? null,
    at: at ?? b.builtAt,
  };
}
