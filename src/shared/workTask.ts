/**
 * WorkTask domain (`domain:'task'`) schema + log payload (J0 §2 D2).
 *
 * ┌── PROTOCOL file: additive-only contract ──────────────────────────────┐
 * │ This schema persists in the append-only log. Boot replay re-parses past   │
 * │ records into this type (same contract as shared/eventlog.ts PROTOCOL      │
 * │ header):                                                                  │
 * │   - Do not remove, rename, or change field meaning (past record parse     │
 * │     collapse).                                                            │
 * │   - New fields must be optional (`?:`) only (absent on old records).      │
 * │   - status·kind enum values: add only; never reuse existing values.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WorkTask does not overload A2A `Task` (shared/types.ts — inter-agent delegation unit)
 * (§1 D1): worktree mission unit (branch·worktreePath·paneGroupId·missionChannelId) with
 * different lifecycle·transition graph. Physically separated from A2A via type name·
 * `domain:'task'` slot·RPC `task.mission.*` prefix.
 *
 * envelope.payload is domain opaque — the log layer does not interpret this type.
 * Interpretation·projection is WorkTaskService (daemon) responsibility.
 */

/**
 * Daemon-stamped identity reference (§2 — same shape as §6.L authContext). authz anchor is
 * verifiedWorkspaceId (principalId is display/routing/audit only).
 */
export interface WorkTaskRef {
  principalId: string;
  verifiedWorkspaceId: string;
}

/**
 * Mission-unit task canonical record (§2 D2). J0 transition graph is single `open → closed`.
 * Materialization fields (branch/worktreePath/paneGroupId/prUrl) are all optional — J1+ fills
 * via `task.update` (fill, not flip).
 */
export interface WorkTask {
  /** 'wtask-' + UUID. Server pre-issues on mission.start entry (§3 topic pre-stamp needed). */
  id: string;
  /** Human-readable one-line mission. Cap: reuses channel topic cap constant (CHANNEL_TOPIC_MAX). */
  title: string;
  /** J0 transition graph is open→closed only (§2). */
  status: 'open' | 'closed';
  /** R3 binding — task owns the link, not the channel (§3). */
  missionChannelId: string;
  createdAt: number;
  closedAt?: number;
  /** Audit meta (immutable). */
  createdBy: WorkTaskRef;
  /**
   * authz anchor (§3 close gate). J0 born-owned: server force-injects from createdBy at
   * creation (not on wire — §5.1). §6.M P2 pool tasks only are born without owner
   * (pending = open ∧ no owner) but J0 always has owner.
   */
  owner: WorkTaskRef;
  // ── J1+ materialization fields (schema only in J0, always optional) ──
  branch?: string;
  worktreePath?: string;
  /**
   * Task-dedicated workspace id (J1 §1 D1 meaning finalized — J0 deferred "group vs pane
   * array" decision). Task execution unit = dedicated workspace; store that workspace id
   * directly (identity-axis separation·reboot survival piggybacks existing workspace persistence).
   * J0 additive-only: field name immutable, meaning only finalized.
   */
  paneGroupId?: string;
  // ── J2 ──
  prUrl?: string;
  // ── §6.M reserved (activated in P2, J0 unimplemented — see §5 contract) ──
  /** lease is daemon-only owned (§5.3) — no caller may write on wire. */
  lease?: { expiresAt: number; claimantRef: string };
}

/**
 * `domain:'task'` log payload discriminated union (§2 D2). kind is a closed enum so
 * projection safely ignores unknown kinds (fail-closed). Log layer does not interpret.
 */
export type WorkTaskEventPayload =
  | WorkTaskCreatePayload
  | WorkTaskClosePayload
  | WorkTaskUpdatePayload;

/** Task creation — carries server-composed WorkTask whole for projection seed. */
export interface WorkTaskCreatePayload {
  kind: 'task.create';
  task: WorkTask;
}

/** Task close — id·closedAt. `evidence?` is §6.M P2 reserved slot (J0 uninterpreted). */
export interface WorkTaskClosePayload {
  kind: 'task.close';
  taskId: string;
  closedAt: number;
  /** §6.M P2 completion evidence reserved slot — J0 close is human action, no gate (§5.5). */
  evidence?: unknown;
}

/**
 * J1+ field patch (§2 D2 — update path pre-reserved). J0 reserves type in union only;
 * handler is J1 work (branch/worktreePath/paneGroupId/prUrl materialization).
 */
export interface WorkTaskUpdatePayload {
  kind: 'task.update';
  taskId: string;
  branch?: string;
  worktreePath?: string;
  paneGroupId?: string;
  prUrl?: string;
}

// ── Constant caps (§2 DoS caps — channel constant reuse convention) ─────────────────────────

/**
 * Open WorkTask cap per workspace (§2·§6 — agent start spam defense). Conservative, same order
 * as channel constant (CHANNEL_MAX_MEMBERS). Explicit error on exceed.
 */
export const WORKTASK_MAX_OPEN_PER_WORKSPACE = 256;

/** §4 idempotency LRU cap — same shape as channel/A2A constant (1000). */
export const WORKTASK_IDEMPOTENCY_CAP = 1000;

/**
 * Task cap per fan-out call (J1 §2 — workspace·PTY burst defense). Separate from J0 open
 * cap (WORKTASK_MAX_OPEN_PER_WORKSPACE=256); limits tasks a single fanout:start call can
 * spawn to 8. Preflight rejects immediately on exceed.
 */
export const FANOUT_MAX_TASKS = 8;

/**
 * Fan-out prompt body cap (J1 §4 G5 — argv limits). `$(cat)` substitution in
 * `{agentCmd} "$(cat {path})"` becomes a single argv, so 8KB platform LCM considering
 * Windows command-line limit (8191 chars)·ARG_MAX. Explicit error on exceed
 * ("shorten the prompt and put details in a file, mention the path").
 */
export const FANOUT_PROMPT_MAX_BYTES = 8 * 1024;

/** closed projection GC threshold (§1 D — review GLM: 7 days). In-memory view bound. */
export const WORKTASK_CLOSED_GC_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * prUrl wire validation (J3 §2 — review G5): accept GitHub PR URL form only. prUrl is non-monotonic
 * mutable field (PR regeneration updates allowed) with no write-once gate — format gate defends
 * against arbitrary URL overwrite.
 */
export const WORKTASK_PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** Mission channel topic anchor prefix (§3) — sole marking for orphan reconcile. */
export const MISSION_TOPIC_PREFIX = 'wmux:mission:';

/** Assemble mission topic anchor string (§3.1 channel pre-stamp). */
export function missionTopicFor(taskId: string): string {
  return `${MISSION_TOPIC_PREFIX}${taskId}`;
}

/**
 * Extract taskId from mission topic (§3 boot reconcile — channel direction). null if not anchor
 * pattern. reconcile archives only "taskId not in projection", so forged topic channels (user
 * manual creation) are also cleaned when no task exists (§6 self-harm limited).
 */
export function taskIdFromMissionTopic(topic: string | undefined): string | null {
  if (typeof topic !== 'string') return null;
  if (!topic.startsWith(MISSION_TOPIC_PREFIX)) return null;
  const id = topic.slice(MISSION_TOPIC_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * worktreePath normalization (§2 exclusivity invariant — review Codex). Collapses same checkout
 * with different notation: trailing slash removal·duplicate slash folding·platform case policy
 * (case-insensitive FS = win/mac). realpath (symlinks) needs daemon filesystem access, so caller
 * responsibility; here handles string normalization only (pure function — testable).
 *
 * **J0 effective note (§2 review — Claude)**: J0 always has worktreePath unset, so this util
 * and exclusivity invariant are contract declaration·normalization only; active use is J1 work.
 */
export function normalizeWorktreePath(raw: string, platform: NodeJS.Platform = process.platform): string {
  let p = raw.trim();
  if (p.length === 0) return p;
  // Unify backslash (win) to slash before comparison (path separator normalization).
  p = p.replace(/\\/g, '/');
  // Fold duplicate slashes (leading UNC `//` not preserved — J0 effective 0, simplified).
  p = p.replace(/\/{2,}/g, '/');
  // Remove trailing slash (except root '/').
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // Case-insensitive FS (win32/darwin): canonical lower-case comparison.
  if (platform === 'win32' || platform === 'darwin') p = p.toLowerCase();
  return p;
}

/**
 * Disk canonical stamp engraved in task meta dir (J3 §1 D1 — CL5). Sidecar allowing reverse
 * lookup of taskId·title from worktree directories left in dedicated root after task projection
 * GC (WORKTASK_CLOSED_GC_MS). closedAt usually absent — meta dir deleted on clean close — only
 * observed in crash window between close↔meta deletion when worktree survives.
 */
export interface WorkTaskMetaStamp {
  taskId: string;
  title: string;
  createdAt: number;
  closedAt?: number;
}

/** Filename for stamp in meta dir (J3 §1 — cleanup scan reverse-lookup canonical). */
export const WORKTASK_META_FILENAME = 'task.json';

// ── J3 IPC wire result types (renderer-safe — pure data, no node import) ──────────
// Main-side services (TaskCloseService·TaskPrService·WorktaskScanService) import node,
// so they cannot enter the renderer bundle. This wire type shared by preload·renderer mirrors
// those service returns (manually kept in sync so tsc catches contract drift).

/** task:close result (mirrors TaskCloseService.CloseTaskResult). */
export type CloseTaskResultWire =
  | { ok: true; taskId: string; archivePending: boolean; unmaterialized?: boolean }
  | {
      ok: false;
      taskId: string;
      reason: 'unpushed' | 'dirty' | 'error';
      error: string;
      preservedWorktree?: string;
      aheadCount?: number;
    };

/** task:create-pr result (mirrors TaskPrService.CreatePrResult). */
export type CreatePrResultWire =
  | { ok: true; prUrl: string; recovered?: boolean; commitPending?: boolean }
  | {
      ok: false;
      reason: 'gh-missing' | 'gh-unauth' | 'dirty' | 'no-origin' | 'push-failed' | 'pr-failed' | 'error';
      error: string;
      browseFallback?: string;
    };

/** Cleanup scan entry 4 kinds (mirrors WorktaskScanService.WorktaskScanEntry). */
export type WorktaskScanCategoryWire =
  | 'unmaterialized-open'
  | 'disk-missing'
  | 'preserved'
  | 'orphan-dir';

export interface WorktaskScanEntryWire {
  category: WorktaskScanCategoryWire;
  taskId?: string;
  title?: string;
  /** F1 — owner (parent) ws id for open-task anomaly entries (reconcile close identity). */
  ownerWorkspaceId?: string;
  worktreePath?: string;
  closedAt?: number;
  detail?: string;
}

/** worktask:scan result (mirrors handler return). */
export type WorktaskScanResultWire =
  | { ok: true; scannedRoot: string; entries: WorktaskScanEntryWire[] }
  | { ok: false; error: string; scannedRoot: string; entries: WorktaskScanEntryWire[] };
