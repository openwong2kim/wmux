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
// mode is honoured only while `permission.grantedRevision === revision`; until
// it is granted again, the schedule's runs are skipped (`needs_regrant`), never
// started in a weaker mode. The grant is written by the daemon from
// `automation.grant`, never from a client payload.

export type AutomationAgent = 'claude' | 'codex';
/**
 * `auto` is Claude's own auto permission mode (claude only): Claude approves
 * routine actions itself and stops risky ones, with no human at the desk.
 */
export type AutomationPermissionMode = 'approval' | 'scoped' | 'auto' | 'bypass';

/**
 * What each agent's scheduled runs support, read instead of comparing agent
 * names: `autoMode` (Claude's own auto permission mode), `toolList` (scoped
 * takes a per-tool allow-list; codex scoped is a fixed sandbox), and the mode a
 * new schedule starts in.
 */
export const AUTOMATION_AGENT_CAPS: Readonly<Record<AutomationAgent, {
  autoMode: boolean;
  toolList: boolean;
  defaultMode: AutomationPermissionMode;
  /**
   * An unattended run with a browser identity keeps the wmux server (main
   * admits only browser calls from it). An agent without per-tool control
   * of that server runs a browser identity in approval mode only.
   */
  unattendedBrowserIdentity: boolean;
}>> = {
  claude: { autoMode: true, toolList: true, defaultMode: 'auto', unattendedBrowserIdentity: true },
  codex: { autoMode: false, toolList: false, defaultMode: 'scoped', unattendedBrowserIdentity: false },
};

export interface AutomationScheduleTrigger {
  kind: 'schedule';
  /** 0 = Sunday … 6 = Saturday (JS Date#getDay). Non-empty, unique, sorted. */
  weekdays: number[];
  /** Local wall-clock time, 24h "HH:MM". Evaluated in the system time zone. */
  time: string;
  /** A missed occurrence still fires if the daemon sees it within this window. */
  graceMinutes: number;
}

/**
 * A schedule's browser identity, as the daemon holds it: a REFERENCE to the
 * snapshot main recorded when the operator confirmed it (keyed by automation
 * id + `boundRevision` in main's own store). The pane, its Chrome profile and
 * its allowed sites live in main; `workspaceId` / `paneId` here are display
 * hints only, never trusted. No create, update or propose payload can carry
 * one — only `automation.grant` from main.
 */
export interface AutomationBrowserIdentity {
  /** Display hint: the workspace of the identity's pane. */
  workspaceId: string;
  /** Display hint: the protected pane. */
  paneId: string;
  /** The automation revision this identity was granted at. */
  boundRevision: number;
}

/** What a daemon advertises on `automation.capabilities`. */
export const AUTOMATION_CAPABILITY_BROWSER_IDENTITY = 'browserIdentity';

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
  /** Absent = no browser identity (the run behaves exactly as before). Daemon-stored from a grant only. */
  browserIdentity?: AutomationBrowserIdentity;
}

export interface AutomationPermission {
  mode: AutomationPermissionMode;
  /**
   * claude scoped only: bare tool names (AUTOMATION_TOOL_NAME_RE). codex has no
   * per-tool allow-list: codex `scoped` means the workspace-write sandbox with
   * no approval prompts, and a grant carrying tools for codex is refused.
   * `approval` pins claude to `--permission-mode default`; codex approval runs
   * use the user's own codex approval configuration unchanged. `auto` is
   * claude only; a codex grant for it is refused.
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
    /**
     * Awaiting-a-human ceiling; absent = AUTOMATION_DEFAULTS (approval
     * 15 min, every other mode 60 min).
     */
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
  | 'cancelled'
  /** The schedule changed after its non-approval mode was granted; it was not started. */
  | 'needs_regrant';

/**
 * How a pasted prompt that was not submitted on the first try was settled:
 * `submit_retried` — Enter was pressed again and the agent took the prompt;
 * `prompt_not_in_composer` — the prompt was nowhere on screen, so nothing was
 * pressed; `submit_unconfirmed` — the prompt stayed unsubmitted until the
 * readiness deadline.
 */
export type AutomationRunDetail =
  | 'submit_retried'
  | 'prompt_not_in_composer'
  | 'submit_unconfirmed'
  /** A browser call was refused because the pane's identity or policy changed since the grant. */
  | 'browser_needs_consent'
  /** A browser call was refused by the pane's policy. */
  | 'browser_policy_denied';

export interface AutomationRun {
  id: string;
  automationId: string;
  /** Automation revision this run executed. */
  revision: number;
  /** Permission mode the run launched with (a stale grant is skipped, never downgraded). */
  effectiveMode: AutomationPermissionMode;
  scheduledFor: number;
  trigger: 'scheduled' | 'manual' | 'test';
  state: AutomationRunState;
  reason?: AutomationRunReason;
  /** Finer cause, where one is recorded (see AutomationRunDetail). */
  detail?: AutomationRunDetail;
  /** Daemon PTY id while the session exists. */
  ptyId?: string;
  /** Agent's own session id (e.g. for `claude --resume <id>`), when known. */
  agentSessionId?: string;
  startedAt?: number;
  endedAt?: number;
  /** True once a plain-text output snapshot was written for this run. */
  hasSnapshot?: boolean;
  /** The browser identity this run launched with (immutable; a later edit never changes it). First-party reads only. */
  browserIdentity?: AutomationBrowserIdentity;
  /** Set on broadcast run events in place of `browserIdentity`, which the event stream never carries. */
  hasBrowserIdentity?: true;
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
  /** Unattended modes (scoped/auto/bypass) fail a run stuck awaiting a human. */
  unattendedAwaitTimeoutMinutes: 60,
  /** Approval runs end when nobody answers for this long, freeing the slot. */
  approvalAwaitTimeoutMinutes: 15,
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
  /** `{ capabilities: string[] }` — an older daemon answers Unknown method. */
  capabilities: 'automation.capabilities',
  /** First-party: the live run behind a run PTY of THIS daemon incarnation, or null. */
  runIdentity: 'automation.runIdentity',
  /** First-party: the live identity runs (for main's process walk). */
  identityRuns: 'automation.identityRuns',
  /** First-party: record a refused browser call on a live run's detail. */
  noteRunBrowser: 'automation.noteRunBrowser',
} as const;

export interface AutomationCapabilitiesResult { capabilities: string[] }

/** `automation.runIdentity` params / reply. */
export interface AutomationRunIdentityParams { ptyId: string }
export interface AutomationRunIdentityResult {
  run: {
    runId: string;
    automationId: string;
    revision: number;
    /** The mode the run launched with (main checks it against what was confirmed). */
    effectiveMode: AutomationPermissionMode;
    ptyId: string;
    browserIdentity: AutomationBrowserIdentity;
  } | null;
}

/** `automation.identityRuns` reply: live runs with a browser identity, and their shell pid. */
export interface AutomationIdentityRunsResult {
  runs: Array<{ ptyId: string; pid: number; automationId: string; revision: number }>;
}

export interface AutomationNoteRunBrowserParams {
  runId: string;
  detail: Extract<AutomationRunDetail, 'browser_needs_consent' | 'browser_policy_denied'>;
}

/**
 * `needs-regrant`: an update changed what runs after a non-approval grant, so
 * the schedule is skipped until a human grants it again.
 */
export type AutomationAttentionKind = 'proposed' | 'grant-raised' | 'needs-regrant';

/**
 * A queued `attention` event. The daemon keeps these until a first-party
 * client acknowledges them, so a desktop that was not connected when a draft
 * arrived (or a grant was raised) still surfaces it on its next `list`.
 */
export interface AutomationAttention {
  id: string;
  automationId: string;
  automationName: string;
  kind: AutomationAttentionKind;
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
  /**
   * The revision the human confirmed. Main reads it before showing its native
   * confirm; the daemon refuses the grant when the schedule has moved on, so a
   * grant never lands on an edit nobody saw.
   */
  expectedRevision?: number;
  /**
   * Main only: the browser identity reference to bind (null removes it). When
   * present the grant requires `expectedRevision`, bumps the revision by one
   * and grants at the new revision, which the identity names as `boundRevision`.
   */
  browserIdentity?: AutomationBrowserIdentity | null;
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
  /** A draft arrived, a grant was raised, or a grant went stale — surface to the human. */
  | { type: 'attention'; automationId: string; automationName: string; kind: AutomationAttentionKind };
