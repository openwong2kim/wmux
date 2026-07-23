// ─── Command Deck — durable loop state (P1 contract + P2 progress file) ──────
//
// The "state layer" of the engineered loop: a small, restart-surviving record of
// WHAT a workspace's orchestrator is trying to accomplish and HOW FAR it got, so
// a fresh brain turn (event-woken, scheduled, or resumed after a reboot) can
// reconstruct the loop without replaying conversation history.
//
// Schema adopted (CONCEPT ONLY, no code copied) from the "Ralph" technique
// (github.com/snarktank/ralph, MIT): a task list where each item carries a
// boolean completion flag, plus an append-only progress log — the durable
// "progress file" a fresh agent instance re-reads to get up to speed. Also
// echoes Anthropic's long-running-harness guidance ("read the progress files to
// get up to speed on what was recently worked on"). See
// plans/loop-engineering-adoption-2026-07-12.md §2 (P1/P2) and §0 for the
// license basis.
//
// Two concepts live here:
//   - LOOP CONTRACT (P1): `objective` + `tasks[]` with a per-item `passes` flag.
//     The loop is DONE when every task passes — it stops because it SUCCEEDED,
//     distinct from the turn budget (which only stops runaway). `isLoopDone`.
//   - DURABLE STATE (P2): `progressLog` (append-only, capped) + `status`.
//
// This module is PURE STATE. It enables NO autonomy by itself — reading/writing
// a loop's objective does not let the brain act. The autonomy gate
// (deckAutonomyStore) and the coalescer still decide what a woken turn may DO.
//
// Storage: one JSON file (`deck-loop-state.json`) in the wmux data dir, atomic
// write, WMUX_DATA_SUFFIX-isolated — same shape as deck-schedules.json /
// deck-autonomy.json. Read-modify-write per mutation against the CURRENT file so
// a concurrent edit isn't clobbered by a stale in-memory copy.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export type LoopStatus = 'idle' | 'running' | 'paused' | 'done';

export interface LoopTask {
  id: string;
  text: string;
  /** Ralph-style completion flag. The loop is done when every task passes. */
  passes: boolean;
}

export interface ProgressEntry {
  ts: number;
  note: string;
}

/** The autonomy tier the one-click form chose. v1 caps out at 'continue' —
 *  'full-auto' (approval-press) is locked behind the hardening pass. Recorded
 *  here so [pause]→[resume] can restore the choice after the OFF contract
 *  dropped the caps to DEFAULT. */
export type LoopTier = 'report' | 'continue';

export interface WorkspaceLoopState {
  /** One-line goal the orchestrator is looping toward. */
  objective: string;
  /**
   * Optional per-iteration procedure — what the brain should do EACH wake, in
   * order (e.g. "/qa run" → "fix failures" → "/review"). Distinct from `tasks`
   * (the done-contract): steps are the HOW of one iteration, tasks are the
   * WHEN-TO-STOP. Free text; a step may reference a pane agent's skill
   * ("/qa") — running it means typing that command into a real pane, per the
   * grounding rules. Empty ⇒ the brain chooses its own approach (v1 behavior).
   */
  steps: string[];
  /** The done-contract: all `passes:true` ⇒ the loop succeeded. */
  tasks: LoopTask[];
  /** Append-only, capped breadcrumb of what happened across iterations. */
  progressLog: ProgressEntry[];
  status: LoopStatus;
  /** Autonomy tier chosen at click time (restored on [resume]). */
  tier: LoopTier;
  /** Auto-wake iteration budget while this loop RUNS (Ralph max-iterations,
   *  adopted from the MIT Ralph technique). While running, the coalescer uses
   *  THIS as the consecutive-auto-wake cap instead of the small global default
   *  — an attended working loop needs dozens of iterations, not 5. Human input
   *  still resets the counter; stopping the loop drops back to the default. */
  iterations: number;
  /** The cadence DeckSchedule this loop created, if the form asked for one.
   *  The OFF contract deletes ([stop]) / disables ([pause]) it — a stopped loop
   *  must never leave a pending schedule behind. */
  scheduleId?: string;
  updatedAt: number;
}

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export const LOOP_STATE_LIMITS = {
  MAX_OBJECTIVE_CHARS: 1000,
  MAX_TASKS: 50,
  MAX_TASK_TEXT: 500,
  MAX_STEPS: 20,
  MAX_STEP_TEXT: 300,
  MAX_PROGRESS_ENTRIES: 100,
  MAX_NOTE_CHARS: 500,
  /** Iteration budget bounds (Ralph max-iterations semantics). */
  MIN_ITERATIONS: 1,
  MAX_ITERATIONS: 100,
  DEFAULT_ITERATIONS: 25,
} as const;

/** Clamp/derive a valid iteration budget; anything unusable → the default. */
function sanitizeIterations(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(n)) return LOOP_STATE_LIMITS.DEFAULT_ITERATIONS;
  return Math.min(LOOP_STATE_LIMITS.MAX_ITERATIONS, Math.max(LOOP_STATE_LIMITS.MIN_ITERATIONS, n));
}

export function getDeckLoopStatePath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-loop-state.json');
}

/** Normalize steps — strings only, trim, drop blank lines, cap count and length. */
function sanitizeSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, LOOP_STATE_LIMITS.MAX_STEPS)
    .map((s) => s.slice(0, LOOP_STATE_LIMITS.MAX_STEP_TEXT));
}

function sanitizeTask(raw: unknown): LoopTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) return null;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
    text: text.slice(0, LOOP_STATE_LIMITS.MAX_TASK_TEXT),
    passes: o.passes === true,
  };
}

function sanitizeState(raw: unknown): WorkspaceLoopState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const objective = typeof o.objective === 'string' ? o.objective.trim() : '';
  if (!objective) return null; // a loop with no objective is not a loop
  const steps = sanitizeSteps(o.steps);
  const tasks = Array.isArray(o.tasks)
    ? o.tasks.map(sanitizeTask).filter((t): t is LoopTask => t !== null).slice(0, LOOP_STATE_LIMITS.MAX_TASKS)
    : [];
  const progressLog = Array.isArray(o.progressLog)
    ? o.progressLog
        .map((e): ProgressEntry | null => {
          if (!e || typeof e !== 'object') return null;
          const eo = e as Record<string, unknown>;
          const note = typeof eo.note === 'string' ? eo.note.trim() : '';
          if (!note) return null;
          return {
            ts: typeof eo.ts === 'number' && Number.isFinite(eo.ts) ? eo.ts : 0,
            note: note.slice(0, LOOP_STATE_LIMITS.MAX_NOTE_CHARS),
          };
        })
        .filter((e): e is ProgressEntry => e !== null)
        .slice(-LOOP_STATE_LIMITS.MAX_PROGRESS_ENTRIES)
    : [];
  const status: LoopStatus =
    o.status === 'running' || o.status === 'paused' || o.status === 'done' ? o.status : 'idle';
  const scheduleId =
    typeof o.scheduleId === 'string' && o.scheduleId.length > 0 ? o.scheduleId : undefined;
  return {
    objective: objective.slice(0, LOOP_STATE_LIMITS.MAX_OBJECTIVE_CHARS),
    steps,
    tasks,
    progressLog,
    status,
    // Fail-closed: anything but an explicit 'continue' loads as 'report'.
    tier: o.tier === 'continue' ? 'continue' : 'report',
    iterations: sanitizeIterations(o.iterations),
    ...(scheduleId ? { scheduleId } : {}),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  };
}

type LoopStateFile = Record<string, WorkspaceLoopState>;

/** Load the whole map; a missing/corrupt file is an empty map (fail open — a
 *  torn store must never brick the deck). Bad keys/entries dropped. */
export function loadDeckLoopState(dir?: string): LoopStateFile {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getDeckLoopStatePath(dir));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: LoopStateFile = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!WORKSPACE_ID_RE.test(k)) continue;
    const s = sanitizeState(v);
    if (s) out[k] = s;
  }
  return out;
}

/** Resolve one workspace's loop, or null when no loop is configured. Never
 *  throws. */
export function loadWorkspaceLoopState(workspaceId: string, dir?: string): WorkspaceLoopState | null {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  try {
    return loadDeckLoopState(dir)[workspaceId] ?? null;
  } catch {
    return null;
  }
}

async function mutate(
  workspaceId: string,
  fn: (prev: WorkspaceLoopState | null) => WorkspaceLoopState | null,
  dir?: string,
): Promise<WorkspaceLoopState | null> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null;
  const all = loadDeckLoopState(dir);
  const next = fn(all[workspaceId] ?? null);
  if (next === null) {
    delete all[workspaceId];
  } else {
    all[workspaceId] = { ...next, updatedAt: Date.now() };
  }
  await atomicWriteJSON(getDeckLoopStatePath(dir), all);
  return next === null ? null : all[workspaceId];
}

/** Start (or replace) a workspace's loop from an objective + optional seed
 *  checklist. Resets progress and sets status 'running'. `tier` defaults to
 *  'report' (fail-closed). */
export async function startLoop(
  workspaceId: string,
  args: {
    objective: string;
    steps?: string[];
    taskTexts?: string[];
    tier?: LoopTier;
    scheduleId?: string;
    iterations?: number;
  },
  dir?: string,
): Promise<WorkspaceLoopState | null> {
  const objective = args.objective.trim();
  if (!objective) return null;
  const tasks: LoopTask[] = (args.taskTexts ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, LOOP_STATE_LIMITS.MAX_TASKS)
    .map((text) => ({ id: randomUUID(), text: text.slice(0, LOOP_STATE_LIMITS.MAX_TASK_TEXT), passes: false }));
  return mutate(
    workspaceId,
    () => ({
      objective: objective.slice(0, LOOP_STATE_LIMITS.MAX_OBJECTIVE_CHARS),
      steps: sanitizeSteps(args.steps),
      tasks,
      progressLog: [],
      status: 'running',
      tier: args.tier === 'continue' ? 'continue' : 'report',
      iterations: sanitizeIterations(args.iterations),
      ...(args.scheduleId ? { scheduleId: args.scheduleId } : {}),
      updatedAt: 0,
    }),
    dir,
  );
}

/** Link (or unlink with undefined) the loop's cadence schedule after creation. */
export async function setLoopScheduleId(
  workspaceId: string,
  scheduleId: string | undefined,
  dir?: string,
): Promise<WorkspaceLoopState | null> {
  return mutate(
    workspaceId,
    (prev) => {
      if (!prev) return null;
      const next = { ...prev };
      if (scheduleId) next.scheduleId = scheduleId;
      else delete next.scheduleId;
      return next;
    },
    dir,
  );
}

/** Append one breadcrumb to the progress log (capped, oldest dropped). No-op if
 *  no loop exists. */
export async function appendProgress(
  workspaceId: string,
  note: string,
  dir?: string,
): Promise<WorkspaceLoopState | null> {
  const trimmed = note.trim();
  if (!trimmed) return loadWorkspaceLoopState(workspaceId, dir);
  return mutate(
    workspaceId,
    (prev) => {
      if (!prev) return null;
      const entry: ProgressEntry = { ts: Date.now(), note: trimmed.slice(0, LOOP_STATE_LIMITS.MAX_NOTE_CHARS) };
      const progressLog = [...prev.progressLog, entry].slice(-LOOP_STATE_LIMITS.MAX_PROGRESS_ENTRIES);
      return { ...prev, progressLog };
    },
    dir,
  );
}

/** Flip a task's `passes` flag. If that completes the contract, status → 'done'. */
export async function setTaskPasses(
  workspaceId: string,
  taskId: string,
  passes: boolean,
  dir?: string,
): Promise<WorkspaceLoopState | null> {
  return mutate(
    workspaceId,
    (prev) => {
      if (!prev) return null;
      const tasks = prev.tasks.map((t) => (t.id === taskId ? { ...t, passes } : t));
      const status: LoopStatus =
        prev.status === 'paused'
          ? 'paused'
          : isDone(tasks)
            ? 'done'
            : prev.status === 'done'
              ? 'running' // a task un-passed after completion re-opens the loop
              : prev.status;
      return { ...prev, tasks, status };
    },
    dir,
  );
}

/** Set the loop status directly (pause/resume/stop-to-idle). */
export async function setLoopStatus(
  workspaceId: string,
  status: LoopStatus,
  dir?: string,
): Promise<WorkspaceLoopState | null> {
  return mutate(
    workspaceId,
    (prev) => (prev ? { ...prev, status } : null),
    dir,
  );
}

/** Remove a workspace's loop entirely. */
export async function clearLoop(workspaceId: string, dir?: string): Promise<void> {
  await mutate(workspaceId, () => null, dir);
}

/** The done-predicate: a non-empty task list all of whose items pass. An empty
 *  task list is NEVER "done" (there is no contract to satisfy — the loop runs on
 *  the objective until the human stops it). */
export function isDone(tasks: readonly LoopTask[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.passes);
}

export function isLoopDone(state: WorkspaceLoopState | null): boolean {
  return state !== null && isDone(state.tasks);
}

/**
 * Render the loop state as a compact block for injection into the orchestrator's
 * turn (the composePrompt seam). This is the brain's OWN objective/progress —
 * trusted context, NOT the untrusted pane-events block. Kept small and
 * structured so a fresh turn re-reads "what am I doing and how far did I get."
 */
export function renderLoopStateBlock(state: WorkspaceLoopState): string {
  const doneCount = state.tasks.filter((t) => t.passes).length;
  const taskLines = state.tasks.map(
    (t) => `  [${t.passes ? 'x' : ' '}] ${t.text}`,
  );
  const recent = state.progressLog.slice(-5).map((e) => `  · ${e.note}`);
  const parts = [
    `[loop] status=${state.status} objective: ${state.objective}`,
    state.tasks.length > 0
      ? `done-when (${doneCount}/${state.tasks.length} passing):\n${taskLines.join('\n')}`
      : 'done-when: (no checklist — run toward the objective until the human stops the loop)',
  ];
  // Iteration procedure (HOW): human-defined order per wake. A skill reference
  // ("/qa") means typing that command into a real pane (same as grounding rules).
  if (state.steps.length > 0) {
    parts.splice(
      1,
      0,
      `steps (follow in order each iteration; "/name" means typing that command into the pane agent):\n${state.steps
        .map((s, i) => `  ${i + 1}. ${s}`)
        .join('\n')}`,
    );
  }
  if (recent.length > 0) parts.push(`recent progress:\n${recent.join('\n')}`);
  return parts.join('\n');
}
