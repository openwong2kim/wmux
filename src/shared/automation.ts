// ─── Scheduled runs — shared contract (daemon ⇄ main ⇄ renderer) ───────────
//
// A schedule ("automation") launches the user's own agent CLI interactively in
// a daemon-owned PTY at a wall-clock time, with no window attached. The daemon
// owns the store, the tick, the launch and the run state machine; the desktop
// only renders and edits through first-party RPCs.
//
// Shape is trigger → action → run so later trigger/action kinds (events,
// chaining, prompt-into-existing-session) slot in without a store migration.
// v1 implements exactly one of each: trigger 'schedule', action 'launch'.
//
// Permission is bound to the schedule's revision: any edit that changes what
// runs (folder, agent, account, prompt) bumps `revision`, and a non-approval
// mode is honoured only while `permission.grantedRevision === revision`. The
// grant is written by the daemon from `automation.grant`, never from a client
// payload.

export type AutomationAgent = 'claude' | 'codex';
export type AutomationPermissionMode = 'approval' | 'scoped' | 'bypass';

export interface AutomationScheduleTrigger {
  kind: 'schedule';
  /** 0 = Sunday … 6 = Saturday (JS Date#getDay). Non-empty, unique, sorted. */
  weekdays: number[];
  /** Local wall-clock time, 24h "HH:MM". Evaluated in the system time zone. */
  time: string;
  /** A missed occurrence still fires if the daemon sees it within this window. */
  graceMinutes: number;
}

export interface AutomationLaunchAction {
  kind: 'launch';
  /** Absolute directory the agent runs in (chosen by the user). */
  cwd: string;
  agent: AutomationAgent;
  /** accounts.json id; absent = the CLI's default config dir. */
  accountId?: string;
  /** Validated against the installed CLI's advertised models. */
  model?: string;
  effort?: string;
  /** Delivered by pasting into the ready agent — never joined into a shell string. */
  prompt: string;
}

export interface AutomationPermission {
  mode: AutomationPermissionMode;
  /**
   * claude scoped only: bare tool names (AUTOMATION_TOOL_NAME_RE). codex has no
   * per-tool allow-list: codex `scoped` means the workspace-write sandbox with
   * no approval prompts, and a grant carrying tools for codex is refused.
   * `approval` pins claude to `--permission-mode default`; codex approval runs
   * use the user's own codex approval configuration unchanged.
   */
  allowedTools?: string[];
  /** Revision the human granted `mode` at. Daemon-written only. */
  grantedRevision?: number;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  /** Set when an agent drafted it via MCP; cleared when a human enables it. */
  proposed?: boolean;
  revision: number;
  trigger: AutomationScheduleTrigger;
  action: AutomationLaunchAction;
  permission: AutomationPermission;
  policy: {
    overlap: 'skip_if_active';
    /** Awaiting-a-human ceiling; absent = only the absolute run cap applies. */
    awaitTimeoutMinutes?: number;
    /** Absolute per-run ceiling (default AUTOMATION_DEFAULTS.maxRunMinutes). */
    maxRunMinutes?: number;
  };
  /** ms epoch of the next occurrence; null when disabled. */
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: 'desktop-ui' | 'mcp-proposal';
}

export type AutomationRunState =
  | 'launching'
  | 'running'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'unknown';

export type AutomationRunReason =
  | 'overlap'
  | 'missed'
  | 'daemon_down'
  | 'first_run_blocked'
  | 'launch_failed'
  | 'account_missing'
  | 'await_timeout'
  | 'timeout'
  | 'agent_error'
  | 'process_exit'
  | 'interrupted'
  | 'cancelled';

export interface AutomationRun {
  id: string;
  automationId: string;
  /** Automation revision this run executed. */
  revision: number;
  /** Effective permission mode after the revision check (may be a downgrade). */
  effectiveMode: AutomationPermissionMode;
  scheduledFor: number;
  trigger: 'scheduled' | 'manual' | 'test';
  state: AutomationRunState;
  reason?: AutomationRunReason;
  /** Daemon PTY id while the session exists. */
  ptyId?: string;
  /** Agent's own session id (e.g. for `claude --resume <id>`), when known. */
  agentSessionId?: string;
  startedAt?: number;
  endedAt?: number;
  /** True once a plain-text output snapshot was written for this run. */
  hasSnapshot?: boolean;
}

/** Terminal states — a run never leaves these. */
export const AUTOMATION_FINAL_RUN_STATES: readonly AutomationRunState[] = [
  'completed',
  'failed',
  'skipped',
  'unknown',
];

export const AUTOMATION_DEFAULTS = {
  graceMinutes: 180,
  maxRunMinutes: 240,
  /** Unattended modes (scoped/bypass) fail a run stuck awaiting a human. */
  unattendedAwaitTimeoutMinutes: 60,
  /** Keep a completed session this long before tree-kill (plain-text last turn). */
  completionLingerMinutes: 10,
  runHistoryPerAutomation: 10,
  snapshotMaxBytes: 64 * 1024,
  maxAutomations: 50,
  maxPromptChars: 8000,
} as const;

/** Daemon PTY ids for scheduled runs carry this prefix (UX filtering only — not a trust signal). */
export const AUTOMATION_PTY_PREFIX = 'auto-';

/** scoped mode v1 accepts bare tool names only — no `Bash(...)` rule patterns. */
export const AUTOMATION_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Editable fields. `permission` is deliberately absent — see `automation.grant`. */
export interface AutomationDraft {
  name: string;
  trigger: AutomationScheduleTrigger;
  action: AutomationLaunchAction;
  policy?: Partial<Pick<Automation['policy'], 'awaitTimeoutMinutes' | 'maxRunMinutes'>>;
}

// ── Daemon RPC contract ─────────────────────────────────────────────────────
// Mutating methods and run snapshots are first-party only (desktop main).
// `list` and `runs` are open to any authenticated client; a non-first-party
// `list` gets each action with an empty `prompt` / `cwd` and no `accountId`.

export const AUTOMATION_RPC = {
  list: 'automation.list',
  runs: 'automation.runs',
  snapshot: 'automation.snapshot',
  create: 'automation.create',
  update: 'automation.update',
  remove: 'automation.delete',
  setEnabled: 'automation.setEnabled',
  grant: 'automation.grant',
  runNow: 'automation.runNow',
  cancelRun: 'automation.cancelRun',
  propose: 'automation.propose',
  ackAttention: 'automation.ackAttention',
} as const;

/**
 * A queued `attention` event. The daemon keeps these until a first-party
 * client acknowledges them, so a desktop that was not connected when a draft
 * arrived (or a grant was raised) still surfaces it on its next `list`.
 */
export interface AutomationAttention {
  id: string;
  automationId: string;
  automationName: string;
  kind: 'proposed' | 'grant-raised';
  at: number;
}

export interface AutomationListResult {
  automations: Automation[];
  /** Unacknowledged attention items, oldest first. */
  pendingAttention?: AutomationAttention[];
}
export interface AutomationRunsParams { automationId?: string }
export interface AutomationRunsResult { runs: AutomationRun[] }
export interface AutomationSnapshotParams { runId: string }
export interface AutomationSnapshotResult { text: string | null }
export interface AutomationCreateParams {
  draft: AutomationDraft;
  /** Create in this state atomically. Absent = enabled (the original behaviour). */
  enabled?: boolean;
}
export interface AutomationUpdateParams { id: string; draft: AutomationDraft }
export interface AutomationRemoveParams { id: string }
export interface AutomationSetEnabledParams { id: string; enabled: boolean }
/** Grants `mode` at the automation's CURRENT revision (daemon records it). */
export interface AutomationGrantParams {
  id: string;
  mode: AutomationPermissionMode;
  allowedTools?: string[];
}
/** `test` runs once without enabling the schedule. */
export interface AutomationRunNowParams { id: string; kind: 'manual' | 'test' }
export interface AutomationCancelRunParams { runId: string }
/** MCP draft path: always stored disabled, proposed, approval mode. */
export interface AutomationProposeParams { draft: AutomationDraft }

export interface AutomationAckAttentionParams { ids: string[] }

export type AutomationRunNowResult =
  | { ok: true; run: AutomationRun }
  | { ok: false; error: string };

export type AutomationOkResult = { ok: true } | { ok: false; error: string };

export type AutomationMutationResult =
  | { ok: true; automation: Automation }
  | { ok: false; error: string };

// ── Daemon → client events (broadcast on the event stream) ──────────────────

export const AUTOMATION_EVENT = 'automation.event';

export type AutomationEvent =
  | { type: 'automations-changed' }
  | { type: 'run-changed'; run: AutomationRun; automationName: string }
  /** A draft arrived, or a permission grant was raised — surface to the human. */
  | { type: 'attention'; automationId: string; automationName: string; kind: 'proposed' | 'grant-raised' };
