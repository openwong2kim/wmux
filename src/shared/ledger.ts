// ─── Task Ledger — shared vocabulary (types only, no runtime) ────────────────
//
// The orchestrator track gives the daemon a task ledger: a STATUS LOG keyed by
// the existing WorkTask id. WorkTask stays the source of identity and
// ownership; the ledger never invents tasks, it records what happened to them
// so the brain, the workers and the Stop gate read ONE state instead of each
// inferring it from pane screens. This file is the contract the daemon
// (writer), the MCP surface (ledger_* tools) and the gate runner (task_gate_run)
// share — it lands ahead of all three so no lane has to stub it.
//
// Status vocabulary mirrors MCP Tasks (working | input_required | completed |
// failed | cancelled) plus `review_requested`: the state a worker hands back
// when it believes it is done. `completed` is reserved for the brain, after a
// gate pass — a worker cannot self-certify.

export const LEDGER_SCHEMA_VERSION = 1 as const;

export const LEDGER_STATUSES = [
  'working',
  'input_required',
  'review_requested',
  'completed',
  'failed',
  'cancelled',
] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** Who wrote an entry. `worker` writes are scoped to the task whose workspace
 *  matches the verified caller; `brain` writes are scoped to tasks the brain's
 *  workspace owns; `system` is the daemon itself (fan-out lifecycle, gate
 *  runner). */
export type LedgerActorKind = 'brain' | 'worker' | 'system';

export interface LedgerActor {
  kind: LedgerActorKind;
  workspaceId: string;
}

/** Result of one gate run, recorded by the gate runner. `command` is the
 *  allow-listed command that ran — never caller-supplied text. */
/** Hard cap on `LedgerGateResult.tail`, enforced by the writer (truncate from
 *  the front, keep the end). The tail is UNTRUSTED text: it is whatever the
 *  gate command printed, and the gate runs code a worker wrote. Consumers
 *  render it as data (a fenced block), never as instructions. */
export const LEDGER_GATE_TAIL_MAX_BYTES = 8 * 1024;

export interface LedgerGateResult {
  /** Process exit code; `null` when the gate died on a signal (timeout,
   *  cancel, OOM). Consumers MUST treat `null` as a failure — only an
   *  explicit 0 is a pass. */
  exitCode: number | null;
  /** Last lines of combined stdout+stderr, ≤ LEDGER_GATE_TAIL_MAX_BYTES.
   *  Untrusted — see the constant. */
  tail: string;
  /** Epoch ms. */
  at: number;
  command: string;
  /** Provenance. The writer stamps `'system'` on a gate it recorded itself
   *  (the gate runner); `completed` trusts ONLY such a gate. Absent on a
   *  result that did not come through the writer's own recordGate path. */
  recordedBy?: LedgerActorKind;
  /** Set by the gate runner when this result is a RECORDED SKIP rather than a
   *  run: the project declares no verify script and no npm lint/test scripts,
   *  so there was nothing to execute. A project that declares no gate has
   *  nothing to fail — `completed` is allowed (the exitCode is 0) and the
   *  ledger says why, in `command: 'none'` and in the tail. The other two skips
   *  (`deps_missing`, `gate_unavailable`) are NOT recorded at all: there a gate
   *  existed and the environment stopped it, which is a human's problem.
   *  `no_changes` (written by the bot task gate, factory/taskGate.ts): the
   *  task's branch has no commits beyond the commit it started from, so a gate
   *  would grade that base and not the task. Recorded the same way, so the
   *  bot that reads the report can settle it `completed` or `failed`; the
   *  system completes nothing on it (isSystemGatePass refuses any skip). */
  skipped?: 'no_gate_command' | 'no_changes';
  /** The worktree HEAD the gate ran on: read by the gate runner before the
   *  run and again after it, and set only when both reads agree. Absent when
   *  HEAD could not be read or moved during the run — such a result is not
   *  evidence about any commit. */
  headSha?: string;
  /** On a `no_changes` record only, stamped by the ledger itself: the
   *  report it was recorded for (LedgerEntry.reportedAtRev then). `completed`
   *  takes the record only while the row's current report is that one. */
  reportRev?: number;
}

export interface LedgerEntry {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  /** WorkTask id. */
  id: string;
  taskWorkspaceId: string;
  ownerWorkspaceId: string;
  title: string;
  status: LedgerStatus;
  gate?: LedgerGateResult;
  summary?: string;
  /** Monotonic revision, +1 per accepted write. Every update names the
   *  `expectedRev` it read; the writer refuses a stale one (compare-and-swap),
   *  so two concurrent writers cannot both pass `canTransition` against the
   *  same snapshot and leave a state the table forbids. */
  rev: number;
  /** Epoch ms of the last transition. */
  updatedAt: number;
  updatedBy: LedgerActor;
  /** How the task was dispatched, written once by main when the row is
   *  registered (never by a worker or a brain): who started the fan-out, with
   *  which preset, and on what checkout. Absent on rows registered before it
   *  existed. */
  dispatch?: LedgerDispatch;
  /** What ended a `completed` row when it was not a gate: `merge` = main
   *  completed it because the pull request from its branch was merged
   *  (factory/taskGate.ts). Set only by main's own in-process ledger write
   *  (LedgerUpdateInput.completion; the ledger RPC never forwards it), never
   *  by a worker or a brain. Absent otherwise. */
  completion?: LedgerCompletion;
  /** The rev of the row's latest move to review_requested (its current
   *  report), written by the ledger on that move. Absent on rows not
   *  reported since it existed. */
  reportedAtRev?: number;
}

/** See LedgerEntry.completion. */
export interface LedgerCompletion {
  source: 'merge';
  /** The merged pull request's number. */
  pr: number;
}

/** See LedgerEntry.dispatch. */
export interface LedgerDispatch {
  /** `tainted`: whether the bot's wake that started it carried outside text
   *  (issue or PR facts, a handoff from such a wake), set by main on every
   *  bot task; the merge lane and remembered rules never merge what such a
   *  task wrote, and a bot task without it counts as tainted. */
  origin: { kind: string; botId?: string; tainted?: boolean };
  /** The fan-out preset name; absent when none. */
  preset?: string;
  /** A code task: the repository it was started in (normalized
   *  `host/owner/repo`; a bot's from its profile at dispatch, an owner's from
   *  the caller repository's origin). A merged pull request ends only a bot
   *  task of its own repository, and task_push and task_fetch work only with
   *  it; absent (a row written before it existed, a research task, an origin
   *  with no `host/owner/repo`) = no merge ends it, and task_fetch refuses a
   *  task that is not a bot's. */
  repoKey?: string;
  /** A code task: the git dir of the repository its worktree was created in
   *  (the repository's common dir, resolved), recorded by main at dispatch.
   *  task_push and task_fetch run git on this path and never on one found
   *  through the worktree; absent (a row written before it existed, a task
   *  with no worktree) = a bot's task uses its profile's repository, any
   *  other task is refused. */
  gitCommonDir?: string;
  /** A code task: the git dir of the task's own worktree
   *  (`<gitCommonDir>/worktrees/<id>`), recorded by main at dispatch. task_push
   *  reads HEAD by this path; absent = derived from the common dir's
   *  `worktrees/` for a row written before it existed. */
  gitWorktreeDir?: string;
  /** A code task: origin's address as the repository config held it
   *  (shared/originPin.ts), recorded by main at dispatch, or at the first
   *  task_push or task_fetch for a row written before it existed. task_push
   *  and task_fetch work only with an origin that matches it. */
  originPin?: string;
  /** Set when the task worktree was created detached at a commit. */
  checkout?: { sha: string; detached: true };
  /** The commit main created the task's branch from (origin's default branch
   *  at fan-out), a full commit id; absent for a detached checkout, a task
   *  with no worktree, one that fell back to the owner's HEAD, and rows
   *  written before it existed. The no-changes check measures against it. */
  baseOid?: string;
  /** A bot's task: the room thread the bot named when it started it (checked
   *  like a post's), else the PR it checks out, else the thread of the wake
   *  that started it (main's own wake state at dispatch). The task's wakes
   *  and cards go there; absent (no thread, `general`, or a row written
   *  before it existed) = the task's own `task:<id>` thread. */
  threadId?: string;
  /** A bot's task: the handoff it belongs to, settled by main at dispatch
   *  (HandoffRouter.taskHandoff): the one the wake that started it
   *  delivered, unless the task's subject (named thread, checked-out PR) is
   *  another open dispatch's to this bot. The task's wakes answer that
   *  handoff: a `result` sent from them, with no replyTo, is that handoff's
   *  result. Absent = none. */
  handoffId?: string;
  /** A bot's task: the connections its worker was started with (names). */
  connectors?: string[];
  /** Written by the WorkTask reconciler for a task it mirrored with no row,
   *  from the task's lineage stamp: only `origin` is known. The fan-out's own
   *  register, when it lands later, replaces it with the full record. */
  reconciled?: true;
}

/** The bot fan-out preset of a research task: no repository, no worktree,
 *  no code (main/worktask/botFanoutPresets.ts). */
export const RESEARCH_PRESET = 'research';

/** Whether a row is a bot's research task: main wrote its dispatch with the
 *  research preset. Such a task changes no code, so there is no gate to run
 *  and its report completes it without one (TaskLedger.update). Pure. */
export function isResearchDispatch(d: LedgerDispatch | undefined): boolean {
  return d?.origin.kind === 'bot' && typeof d.origin.botId === 'string' && d.origin.botId.length > 0 && d.preset === RESEARCH_PRESET;
}

// Lifecycle rules the writer enforces (stated here so the three consumers
// agree):
// - When the WorkTask is closed or detached, the writer force-terminates its
//   entry: `cancelled` if not yet `completed`. A closed task never stays
//   `working` in the ledger.
// - Terminal entries (`completed` / `cancelled`) are pruned after
//   LEDGER_TERMINAL_RETENTION_MS; the JSONL log rotates independently.
export const LEDGER_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses a WORKER may set on its own task. Everything else is the brain's
 *  or the daemon's. */
export const WORKER_SETTABLE_STATUSES: readonly LedgerStatus[] = [
  'working',
  'input_required',
  'review_requested',
  'failed',
];

/** Allowed transitions. A status maps to the statuses it may move to; a
 *  missing key is terminal. `completed` is reachable only from
 *  `review_requested` (and only with a passing gate — enforced by the writer,
 *  not expressible here). */
export const LEDGER_TRANSITIONS: Readonly<Record<LedgerStatus, readonly LedgerStatus[]>> = {
  working: ['input_required', 'review_requested', 'failed', 'cancelled'],
  // A blocked worker may clear its own blocker and hand the task straight to
  // review; forcing a `working` hop in between would only add a write.
  input_required: ['working', 'review_requested', 'failed', 'cancelled'],
  // The brain may bounce a review back with a question (input_required)
  // without pretending the worker resumed (working).
  review_requested: ['working', 'input_required', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['working', 'cancelled'],
  cancelled: [],
};

export function isLedgerStatus(value: unknown): value is LedgerStatus {
  return typeof value === 'string' && (LEDGER_STATUSES as readonly string[]).includes(value);
}

/** False for any unknown status on either side — the MCP surface and the log
 *  replay hand this raw strings, and a lookup miss must be a refusal, not a
 *  TypeError. A same-status resubmit is a no-op and allowed, so a retry after
 *  an ambiguous timeout is not rejected as an illegal transition. */
export function canTransition(from: string, to: string): boolean {
  if (!isLedgerStatus(from) || !isLedgerStatus(to)) return false;
  if (from === to) return true;
  return LEDGER_TRANSITIONS[from].includes(to);
}

/** May `actor` see `entry` at all? The daemon (`system`) sees every task; a
 *  brain or a worker sees the tasks its workspace owns or runs — the same set
 *  `ledger.list` answers with. A refusal carries the entry only to an actor
 *  that may see it. */
export function canActorSee(actor: LedgerActor, entry: LedgerEntry): boolean {
  if (actor.kind === 'system') return true;
  return entry.ownerWorkspaceId === actor.workspaceId || entry.taskWorkspaceId === actor.workspaceId;
}

/** The single authorization predicate every writer calls. A worker may only
 *  move ITS OWN task (the entry's task workspace is the caller's verified
 *  workspace) to a worker-settable status; a brain may move tasks its
 *  workspace owns; the daemon (`system`) may move anything. Transition
 *  legality is `canTransition`, checked separately. */
export function canActorSet(actor: LedgerActor, entry: LedgerEntry, next: LedgerStatus): boolean {
  switch (actor.kind) {
    case 'system':
      return true;
    case 'brain':
      return entry.ownerWorkspaceId === actor.workspaceId;
    case 'worker':
      return entry.taskWorkspaceId === actor.workspaceId && WORKER_SETTABLE_STATUSES.includes(next);
    default:
      return false;
  }
}
