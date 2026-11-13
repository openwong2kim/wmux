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

import type { CompletionEvidence } from './types';

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
  /** Durable completion proof. Main may supply a verified merge; the ledger
   *  itself stamps an unforced completion of the latest system-gated report.
   *  RPC callers cannot supply either stamp. Legacy/manual rows have none. */
  completion?: LedgerCompletion;
  /** The rev of the row's latest move to review_requested (its current
   *  report), written by the ledger on that move. Absent on rows not
   *  reported since it existed. */
  reportedAtRev?: number;
  /** Completion evidence for a research / no-changes task (shared/types
   *  CompletionEvidence). Set on the report or at system settle; never a
   *  substitute for the code-task gate. Absent = not recorded. */
  evidence?: CompletionEvidence;
  /** Grade of `evidence` (shared/completionEvidence.ts): count of verified
   *  items. 0 = Not verified. Written only by main / the ledger, never
   *  trusted from the worker's word alone. */
  verifiedItemCount?: number;
  /** A task another PC runs (fanout_start with `pc`): it has no workspace,
   *  pane or worktree here, and its `taskWorkspaceId` is
   *  {@link remoteTaskWorkspaceId}. Written by main only. Absent on every
   *  local row and on rows from before it existed. */
  remote?: LedgerRemote;
}

/** What this PC knows of a task another PC runs for it (LedgerEntry.remote). */
export interface LedgerRemote {
  /** The other PC: its host id, and the name the caller gave. */
  hostId: string;
  pc: string;
  /** The start request this PC sent (`sp-<uuid>`). */
  spawnId: string;
  /** The folder on that PC, by the id it offers. */
  root: string;
  /** The request's state as last seen. */
  state: LedgerRemoteState;
  /** Why it was refused (an A2A spawn code). */
  code?: string;
  /** Set once it started: the link to it and the task its replies arrive on. */
  linkId?: string;
  a2aTaskId?: string;
  /** The branch the agent works on, on that PC (set once it started; the
   *  branch name follows from the other PC's mode, which the link shows). */
  branchOnPc?: string;
  /** The task was closed (or expired) here: a start that arrives later is
   *  ended at once instead of left running. */
  withdrawn?: true;
  /** A withdrawn task's link was revoked here (a failed revoke is retried). */
  revoked?: true;
  /** The sha256 (hex) of the whole fan-out call that asked for it: a later
   *  call with the same key is a poll only when it sends the same request. */
  requestDigest?: string;
  /** The pane that asked for it: told when the task needs it or fails. */
  from?: { paneId: string };
  /** What the agent on that PC waits on while the row stays open: a question
   *  on its screen (the row is input_required) or its usage limit (the row
   *  stays working; that PC resumes it by itself). Kinds only, never its text. */
  waiting?: LedgerRemoteWaiting;
  /** When this PC first saw the agent gone (or its task no longer listed)
   *  while the task was still open here (epoch ms): the row fails once
   *  REMOTE_GONE_GRACE_MS passed with nothing ending the task meanwhile. */
  goneSeenAt?: number;
  /** The id of the other PC's message that reported it (its remote message
   *  id, A2A_REMOTE_MESSAGE_ID_RE), the one this row moved to review_requested
   *  on: another id is a new report, after a follow-up. Not a time. */
  reportId?: string;
  /** While the row is input_required: what its text says it waits for, when
   *  the follow pass wrote that text (`reply`, `stopped`, `question`,
   *  `question:<kind>`), or `other` when someone else moved it there with a
   *  text of their own. The pass writes a new text only when this changes,
   *  and over `other` only once the agent waits for something new. The
   *  ledger clears it on any other status change. */
  waitsFor?: LedgerRemoteWaitsFor;
}

export type LedgerRemoteWaitsFor = 'reply' | 'stopped' | 'question' | `question:${LedgerRemoteQuestion}` | 'other';

export const LEDGER_REMOTE_QUESTIONS = ['permission', 'plan', 'menu', 'dialog', 'trust'] as const;
export type LedgerRemoteQuestion = typeof LEDGER_REMOTE_QUESTIONS[number];

/** Whether `v` is a `waitsFor` value. */
export function isLedgerRemoteWaitsFor(v: unknown): v is LedgerRemoteWaitsFor {
  if (v === 'reply' || v === 'stopped' || v === 'question' || v === 'other') return true;
  return typeof v === 'string' && v.startsWith('question:') && (LEDGER_REMOTE_QUESTIONS as readonly string[]).includes(v.slice('question:'.length));
}

export interface LedgerRemoteWaiting {
  on: 'question' | 'usage-limit';
  /** When it began on that PC (ISO). */
  since: string;
  question?: typeof LEDGER_REMOTE_QUESTIONS[number];
  /** usage-limit: when the provider's window resets (ISO), once known. */
  resetsAt?: string;
}

export const LEDGER_REMOTE_STATES = ['sent', 'waiting', 'started', 'refused', 'expired'] as const;
export type LedgerRemoteState = typeof LEDGER_REMOTE_STATES[number];

/** The `taskWorkspaceId` of a remote task: never a workspace id (none holds a ':'). */
export const REMOTE_TASK_WORKSPACE_PREFIX = 'remote:';

export function remoteTaskWorkspaceId(spawnId: string): string {
  return `${REMOTE_TASK_WORKSPACE_PREFIX}${spawnId}`;
}

/** Whether a row (or the task workspace id of one) is a task another PC runs. */
export function isRemoteTask(row: { taskWorkspaceId: string; remote?: unknown } | string): boolean {
  if (typeof row === 'string') return row.startsWith(REMOTE_TASK_WORKSPACE_PREFIX);
  return row.remote !== undefined || row.taskWorkspaceId.startsWith(REMOTE_TASK_WORKSPACE_PREFIX);
}

/** See LedgerEntry.completion. */
export type LedgerCompletion =
  | { source: 'merge'; pr: number }
  | { source: 'gate'; headSha: string; reportRev: number };

/** See LedgerEntry.dispatch. */
export interface LedgerDispatch {
  /** Main-only durable workflow binding; never accepted from fan-out parameters. */
  workflow?: { id: string; step: number };
  /** `tainted`: whether the bot's wake that started it carried outside text
   *  (issue or PR facts, a handoff from such a wake), set by main on every
   *  bot task; the merge lane and remembered rules never merge what such a
   *  task wrote, and a bot task without it counts as tainted. `guest`: the
   *  starting wake's guest provenance (wakeTaint.ts), written by main on
   *  every bot task; absent reads as unknown unless the task is clean. */
  origin: { kind: string; botId?: string; tainted?: boolean; guest?: boolean };
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
  /** A bot's task: which of `connectors` go through main's gateway (signed-in
   *  connections, main/connectors/workerGateway.ts; all of them, when any).
   *  Such a task runs only with the research preset, takes messages and
   *  resumes only from a clean wake, and starts again only in a new pane. */
  gatewayConnectors?: string[];
  /** Completion criteria for a research task, set only by main at dispatch
   *  (never by a worker): what the worker's evidence should show. A task's
   *  no-changes skip is known only after its run, so such a task has none;
   *  its evidence is graded the same way (TaskLedger.update). */
  criteria?: string[];
  /** Written by the WorkTask reconciler for a task it mirrored with no row,
   *  from the task's lineage stamp: only `origin` is known. The fan-out's own
   *  register, when it lands later, replaces it with the full record. */
  reconciled?: true;
}

/** The bot fan-out preset of a research task: no repository, no worktree,
 *  no code (main/worktask/botFanoutPresets.ts). */
export const RESEARCH_PRESET = 'research';

/** Whether a ledger row's task used a signed-in connection: a bot's task
 *  main started through its gateway (fanout.rpc.ts records the names). What
 *  its worker read is its bot's alone: its summary rides on no fact and no
 *  shared card (factIngest.ts). Pure. */
export function taskSignedIn(row: Pick<LedgerEntry, 'dispatch'>): boolean {
  return row.dispatch?.origin.kind === 'bot' && (row.dispatch.gatewayConnectors?.length ?? 0) > 0;
}

/** Whether a row is a bot's research task: main wrote its dispatch with the
 *  research preset. Such a task changes no code, so there is no code gate to
 *  run; its report still records criteria/evidence (Not verified when missing)
 *  and then completes (TaskLedger.update). Pure. */
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
