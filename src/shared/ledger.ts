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
export interface LedgerGateResult {
  /** Process exit code; `null` when the gate died on a signal (timeout,
   *  cancel, OOM). Consumers MUST treat `null` as a failure — only an
   *  explicit 0 is a pass. */
  exitCode: number | null;
  /** Last lines of combined output, bounded by the runner. */
  tail: string;
  /** Epoch ms. */
  at: number;
  command: string;
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
  /** Epoch ms of the last transition. */
  updatedAt: number;
  updatedBy: LedgerActor;
}

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
  review_requested: ['working', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['working', 'cancelled'],
  cancelled: [],
};

export function isLedgerStatus(value: unknown): value is LedgerStatus {
  return typeof value === 'string' && (LEDGER_STATUSES as readonly string[]).includes(value);
}

/** False for any unknown status on either side — the MCP surface hands this
 *  raw strings, and a lookup miss must be a refusal, not a TypeError. */
export function canTransition(from: string, to: string): boolean {
  if (!isLedgerStatus(from) || !isLedgerStatus(to)) return false;
  return LEDGER_TRANSITIONS[from].includes(to);
}
