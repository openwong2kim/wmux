/**
 * A2aTaskService — **daemon-side source of truth** for A2A tasks (envelope-design §5 D11).
 *
 * Previously the A2A source of truth was the renderer in-memory store (a2aSlice) — non-durable
 * with 30-minute GC, asymmetric with channels. This service moves the source of truth to the
 * daemon append-only log:
 *   - projection-first: holds a task-map projection; every transition is **committed first
 *     (append→true) as a `domain:'a2a'` envelope, then applied to the projection**. If append
 *     returns false (batch rollback), the projection is untouched — the log is the source of truth.
 *   - `VALID_TRANSITIONS`(types.ts) enforced on the daemon (successful terminal = 'completed').
 *   - completion evidence: §6.M PR-B gate **active**. Terminal transitions (completed/failed)
 *     require structured evidence (validateCompletionEvidence) — completed = summary + ≥1
 *     well-formed item, failed = summary (reason). normalizeCompletionEvidenceWire re-validates
 *     (sanitizes) first, then the gate decides. verified≥1 is not a gate but a **grade** (E9) for
 *     completed — verifiedItemCount only computes and records honestly.
 *   - per-task serialization (mutex) for collect→append→apply consistency.
 *   - clientMsgId-style idempotency (§4): (taskId, idempotencyKey) LRU — retries return the
 *     original result without append (same-key retry → one log entry).
 *   - 30-minute GC semantics remain at projection level (matches current a2aSlice; no log truncation).
 *
 * authContext stamping (§7 PR5): verifiedWorkspaceId is the server-pinned authz anchor (caller-provided);
 * principalId is a display/routing stamp **derived server-side** from stored task coordinates (not
 * forgeable — sender claims are not trusted, §7:356); trustTier is fixed at 'semi-trusted' (§7 table:
 * A2A execute = ClaudeWorker we spawned). principalId/trustTier are not authz — the permission
 * anchor is verifiedWorkspaceId only (§7:358).
 */

import { makeEnvelope } from '../../shared/eventlog';
import type {
  AuthContext,
  EventEnvelope,
  EventEnvelopeDraft,
} from '../../shared/eventlog';
import { panePrincipalId } from '../../shared/principals';
import type {
  Artifact,
  CompletionEvidence,
  Message,
  Task,
  TaskState,
  WmuxTaskMetadata,
} from '../../shared/types';
import { validateTransition, VALID_TRANSITIONS, TERMINAL_STATES } from '../../shared/types';
import {
  isVerifiedItem,
  normalizeCompletionEvidenceWire,
  validateCompletionEvidence,
} from '../../shared/completionEvidence';
import type {
  A2aTaskCancelPayload,
  A2aTaskCreatePayload,
  A2aTaskTransitionPayload,
} from '../../shared/a2aEventlog';

/** Matches current a2aSlice values (same semantics as the cache). */
const GC_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const GC_MAX_TASKS = 500;
/** §4: idempotency LRU cap/stream — same shape as channel constant (CHANNEL_IDEMPOTENCY_CAP=1000). */
const IDEMPOTENCY_CAP = 1000;

/**
 * Completion-evidence gate (§6.M PR-B) rejection code → human action hint (design §⑤). Codes are
 * stable machine-parseable identifiers; hints are human-readable phrases telling the sending agent
 * what to attach before retrying. shared/completionEvidence stays unchanged except comments (schema
 * owned by envelope PR5 — X9), so hint mapping lives locally at each enforcement site (daemon and
 * renderer fallback).
 */
function evidenceGateHint(code: string): string {
  switch (code) {
    case 'completion_evidence_missing':
      return "status 'completed' requires structured completion evidence (summary + >=1 well-formed item)";
    case 'completion_evidence_empty_summary':
      return "status 'completed' requires a non-empty evidence summary";
    case 'completion_evidence_no_items':
      return "status 'completed' requires >=1 well-formed evidence item (command|inspection|artifact)";
    case 'completion_evidence_invalid_item':
      return 'evidence has a malformed item (command items need a non-empty command; every item needs a non-empty summary)';
    case 'completion_evidence_too_large':
      return 'evidence exceeds size caps (items/strings/files/total bytes)';
    case 'completion_evidence_bad_file_path':
      return 'evidence.files must be repo-relative paths (no absolute, drive, ADS, url-scheme, or ".." segments)';
    case 'failure_reason_missing':
      return "status 'failed' requires an evidence summary (the failure reason)";
    default:
      return 'attach valid completion evidence and retry';
  }
}

/** Minimal log interface requiring only append + readAllRecords (satisfied by AppendOnlyLog). */
export interface A2aLogLike {
  append(draft: EventEnvelopeDraft): Promise<boolean>;
  readAllRecords(): EventEnvelope[];
}

export interface A2aTaskServiceOptions {
  log: A2aLogLike;
  /** envelope origin (§8). machineId and daemonEpoch are fixed at boot. */
  origin: { machineId: string; daemonEpoch: number };
  /** GC/timestamp injection (tests). Defaults to Date.now. */
  now?: () => number;
}

/** One pane coordinate (optional pane-granular authz). */
export interface PaneAddr {
  paneId?: string;
  surfaceId?: string;
}

export interface CreateTaskInput {
  id?: string;
  title: string;
  from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
  to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string; ptyId?: string };
  history?: Message[];
  artifacts?: Artifact[];
}

export interface TransitionInput {
  taskId: string;
  to: TaskState;
  /** Server-pinned caller workspace (must be the receiver). */
  callerWorkspaceId: string;
  /** Caller pane when known (pane-granular authz). null/undefined for headless. */
  callerAddr?: PaneAddr | null;
  /**
   * Whether the caller claimed pane identity (senderPtyId). S-C2 pane-granular authz can only
   * be decided in the renderer pane tree (ptyId→pane resolution is renderer-owned) — when a
   * pane-identity caller hits a pane-pinned task (to.paneId), the daemon soft-defers and main
   * falls back to the renderer verification path (preserves today's decision point; server-side
   * migration is PR5/§7).
   */
  callerHasPaneIdentity?: boolean;
  /** Human-readable status message (when present). */
  message?: Message;
  /** §6.M completion evidence (raw). Service re-normalizes (sanitizes) for storage — no gate here. */
  evidence?: unknown;
  /** §4 idempotency key (clientMsgId-style). Absorbs retries. */
  idempotencyKey?: string;
}

export interface CancelTaskInput {
  taskId: string;
  callerWorkspaceId: string;
  idempotencyKey?: string;
}

export type OpErr = { ok: false; error: string };
/**
 * Successful transition/cancel/create results carry the committed task snapshot — the renderer
 * cache applies this value **verbatim without re-validation** (§6.M C6, a2aSlice.applyDaemonTaskUpdate).
 */
export type TransitionOk = { ok: true; verifiedItemCount?: number; task: Task };
export type CancelOk = { ok: true; task: Task };
export type CreateOk = { ok: true; taskId: string; task: Task };

export interface QueryFilters {
  status?: TaskState;
  role?: 'user' | 'agent';
  updatedSince?: string;
}

export class A2aTaskService {
  private readonly log: A2aLogLike;
  private readonly origin: { machineId: string; daemonEpoch: number };
  private readonly now: () => number;

  /** projection: taskId → Task (in-memory view of source-of-truth state, re-derivable from log). */
  private readonly tasks = new Map<string, Task>();
  /** per-task serialization chain (collect→append→apply consistency). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** §4 idempotency: streamId(taskId) → (idempotencyKey → original result). LRU cap. */
  private readonly idempotency = new Map<string, Map<string, TransitionOk | CancelOk>>();

  constructor(opts: A2aTaskServiceOptions) {
    this.log = opts.log;
    this.origin = opts.origin;
    this.now = opts.now ?? Date.now;
  }

  // ── boot restore (cross-restart projection) ────────────────────────────

  /**
   * Replay `domain:'a2a'` records from the log in order to restore the projection.
   * Core value of non-durable→durable transition: tasks survive restart. Call once at boot.
   */
  restoreFromLog(): void {
    for (const rec of this.log.readAllRecords()) {
      if (rec.domain !== 'a2a') continue;
      this.applyPayload(rec.payload);
      this.restoreIdempotency(rec); // E: cross-restart idempotency re-seed
    }
    // A: GC immediately after boot — purge terminal tasks older than 30 minutes. The log is
    // permanent, so without this restore resurrects every historical terminal task each boot
    // (unbounded projection growth) and exposes them via query. GC bounds projection only (log
    // truncation is §9 compaction's job).
    this.gcTerminalTasks();
  }

  /**
   * E (panel): Rebuild idempotency LRU from replay so same idempotencyKey retries after restart
   * return the original result. Without this, retries become cache misses → invalid transition
   * (task already advanced). Only transition/cancel carry keys (create is idempotent via deterministic id).
   */
  private restoreIdempotency(rec: EventEnvelope): void {
    if (!rec.idempotencyKey) return;
    const p = rec.payload as { kind?: unknown; taskId?: unknown; verifiedItemCount?: unknown };
    if (p.kind !== 'task.transition' && p.kind !== 'task.cancel') return;
    if (typeof p.taskId !== 'string') return;
    const task = this.tasks.get(p.taskId);
    if (!task) return;
    const result: TransitionOk | CancelOk =
      p.kind === 'task.transition'
        ? {
            ok: true,
            task,
            ...(typeof p.verifiedItemCount === 'number' ? { verifiedItemCount: p.verifiedItemCount } : {}),
          }
        : { ok: true, task };
    this.idempotencyRecord(
      p.taskId,
      rec.idempotencyKey,
      p.kind === 'task.transition' ? 'transition' : 'cancel',
      result,
    );
  }

  /**
   * Apply payload to projection (call only after successful append). kind is a closed union, so
   * unknown kinds (executor-lifecycle reserved slots, etc.) are safely ignored (fail-closed).
   */
  private applyPayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as { kind?: unknown };
    if (p.kind === 'task.create') {
      const { task } = payload as A2aTaskCreatePayload;
      if (task && typeof task.id === 'string' && !this.tasks.has(task.id)) {
        this.tasks.set(task.id, task);
      }
      return;
    }
    if (p.kind === 'task.transition') {
      const t = payload as A2aTaskTransitionPayload;
      const task = this.tasks.get(t.taskId);
      if (!task) return;
      task.status = {
        state: t.to,
        timestamp: t.timestamp,
        ...(t.message ? { message: t.message } : {}),
        ...(t.evidence ? { evidence: t.evidence } : {}),
      };
      task.metadata.updatedAt = t.timestamp;
      return;
    }
    if (p.kind === 'task.cancel') {
      const c = payload as A2aTaskCancelPayload;
      const task = this.tasks.get(c.taskId);
      if (!task) return;
      task.status = { state: 'canceled', timestamp: c.timestamp };
      task.metadata.updatedAt = c.timestamp;
      return;
    }
    // executor-lifecycle / unknown kind: reserved slot — ignore in projection.
  }

  // ── mutation ───────────────────────────────────────────────────────

  /**
   * Create task → append `task.create` envelope → seed projection.
   * Idempotent (A3): if the same id already exists, keep existing state without append (prevents completed-task resurrection).
   */
  createTask(input: CreateTaskInput): Promise<CreateOk | OpErr> {
    const id = input.id ?? this.generateTaskId();
    return this.withTaskLock(id, async () => {
      // A3 idempotency: deterministic id (chmention-*) redelivery preserves existing state.
      const existing = this.tasks.get(id);
      if (existing) return { ok: true, taskId: id, task: existing };

      const nowIso = this.isoNow();
      const metadata: WmuxTaskMetadata = {
        title: input.title,
        from: input.from,
        to: input.to,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const task: Task = {
        kind: 'task',
        id,
        status: { state: 'submitted', timestamp: nowIso },
        history: input.history ?? [],
        artifacts: input.artifacts ?? [],
        metadata,
      };
      const payload: A2aTaskCreatePayload = { kind: 'task.create', task };
      // create actor = sender (from) — derive principalId server-side from from pane coordinates.
      const committed = await this.log.append(
        this.envelope(payload, input.from.workspaceId, this.derivePrincipalId(task, 'from', input.from.workspaceId)),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.create: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      return { ok: true, taskId: id, task };
    });
  }

  /**
   * State transition — daemon source-of-truth gate. Enforces authz + VALID_TRANSITIONS + completion-evidence gate (PR-B).
   * Applies projection only after append(true). With idempotency key, absorbs retries (one log entry).
   */
  transition(input: TransitionInput): Promise<TransitionOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.update: task not found: ${input.taskId}` };

      // Authz: only the receiver workspace may update state (current a2aSlice contract).
      if (task.metadata.to.workspaceId !== input.callerWorkspaceId) {
        return { ok: false, error: `a2a.task.update: caller ${input.callerWorkspaceId} is not the receiver` };
      }
      // pane-granular authz (S-C2): when caller pane is known (callerAddr) and the task is pinned to a
      // specific receiver pane (to.paneId), it must match. Missing callerAddr (headless ClaudeWorker)
      // → ws-authz — this invariant must not block worker completion transitions.
      if (input.callerAddr && task.metadata.to.paneId && task.metadata.to.paneId !== input.callerAddr.paneId) {
        return { ok: false, error: 'a2a.task.update: caller pane is not the addressed receiver pane' };
      }
      // S-C2 soft-defer: pane-pinned task + pane-identity caller but callerAddr unresolved
      // (ptyId→pane resolution is renderer-owned) — passing via ws-authz on the daemon would bypass
      // today's pane gate (a2aSlice). Soft-reject to fall back to renderer verification path
      // (main's A2A_DAEMON_SOFT_ERRORS contract).
      if (input.callerHasPaneIdentity && !input.callerAddr && task.metadata.to.paneId) {
        return { ok: false, error: 'a2a.task.update: pane-authz deferred to renderer (pane-pinned task)' };
      }
      // §4 idempotency: same key committed earlier → return original result without append. Position is
      // **after** authz and soft-defer (review codex delta: hit before authz lets a non-participant who
      // knows the key replay committed snapshots — authz bypass), **before** validateTransition (so
      // terminal retries are not misreported as invalid transition). Legitimate retries always re-pass
      // authz because input is identical.
      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey, 'transition');
      if (cached) return cached as TransitionOk;
      // VALID_TRANSITIONS enforced on daemon (successful terminal = 'completed').
      if (!validateTransition(task.status.state, input.to)) {
        const from = task.status.state;
        const allowed = VALID_TRANSITIONS[from];
        const guidance = allowed.length
          ? `allowed next: [${allowed.join(', ')}]`
          : `'${from}' is a terminal state with no further transitions`;
        return { ok: false, error: `a2a.task.update: invalid transition ${from} -> ${input.to}. ${guidance}.` };
      }

      // evidence normalization (§6.M): re-validate (sanitize) untrusted wire. Malformed shapes are
      // rejected the same way as the renderer wire boundary (useRpcBridge completion_evidence_malformed)
      // — silent drop would split renderer (reject) and daemon (commit). Unknown kinds and type-confused
      // items die here as malformed; shape-valid but not well-formed items (empty command, etc.) are
      // caught below by the gate as completion_evidence_invalid_item.
      let evidence: CompletionEvidence | undefined;
      let verifiedItemCount: number | undefined;
      if (input.evidence !== undefined) {
        const normalized = normalizeCompletionEvidenceWire(input.evidence);
        if (!normalized) {
          return {
            ok: false,
            error: 'a2a.task.update: completion_evidence_malformed: evidence must be a plain object with string summary and well-formed items',
          };
        }
        evidence = normalized;
      }

      // Completion-evidence gate (§6.M PR-B — active). Terminal transitions (completed/failed) require
      // structured evidence. pane-authz and illegal-transition rejection (above) run before the gate,
      // so the gate only sees legal transitions (preserves existing error messages and dogfood assertions).
      // verified≥1 is a grade (E9), not a gate — verdict honestly computes verifiedItemCount (0 allowed).
      if (input.to === 'completed' || input.to === 'failed') {
        const verdict = validateCompletionEvidence(input.to, evidence);
        if (!verdict.ok) {
          return { ok: false, error: `a2a.task.update: ${verdict.code}: ${evidenceGateHint(verdict.code)}` };
        }
        verifiedItemCount = verdict.verifiedItemCount;
      } else if (evidence !== undefined) {
        // Non-terminal transitions (working/input-required) are not gate targets — accept evidence + grade count only.
        verifiedItemCount = evidence.items.filter(isVerifiedItem).length;
      }

      const payload: A2aTaskTransitionPayload = {
        kind: 'task.transition',
        taskId: input.taskId,
        to: input.to,
        timestamp: this.isoNow(),
        ...(input.message ? { message: input.message } : {}),
        ...(evidence ? { evidence } : {}),
        ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
      };
      // transition actor = receiver (authz forces callerWorkspaceId === to.workspaceId) —
      // derive principalId server-side from stored to pane coordinates (not forgeable).
      const authWs = input.callerWorkspaceId;
      const committed = await this.log.append(
        this.envelope(payload, authWs, this.derivePrincipalId(task, 'to', authWs), input.idempotencyKey),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.update: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      const result: TransitionOk = {
        ok: true,
        ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
        task, // committed projection snapshot — source for cache verbatim apply (C6)
      };
      this.idempotencyRecord(input.taskId, input.idempotencyKey, 'transition', result);
      return result;
    });
  }

  /**
   * Cancel — allowed for sender or receiver. VALID_TRANSITIONS (→canceled) enforced.
   */
  cancelTask(input: CancelTaskInput): Promise<CancelOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.cancel: task not found: ${input.taskId}` };

      const isSender = task.metadata.from.workspaceId === input.callerWorkspaceId;
      const isReceiver = task.metadata.to.workspaceId === input.callerWorkspaceId;
      if (!isSender && !isReceiver) {
        return { ok: false, error: `a2a.task.cancel: caller ${input.callerWorkspaceId} is not sender or receiver` };
      }
      // §4 idempotency: symmetric with transition — hit after authz (blocks non-participant key replay),
      // op namespace separation (cancel cannot replay transition results with the same key — codex delta).
      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey, 'cancel');
      if (cached) return cached as CancelOk;
      // G (panel): already terminal → idempotent no-op success — cancel's goal (reach terminal) is
      // already satisfied. Rejecting would regress vs the former renderer passthrough path (caller
      // pressed cancel but gets an error). Return current state without log append.
      if ((TERMINAL_STATES as readonly string[]).includes(task.status.state)) {
        return { ok: true, task };
      }
      if (!validateTransition(task.status.state, 'canceled')) {
        return { ok: false, error: `a2a.task.cancel: cannot cancel task in state ${task.status.state}` };
      }

      const payload: A2aTaskCancelPayload = {
        kind: 'task.cancel',
        taskId: input.taskId,
        timestamp: this.isoNow(),
      };
      // cancel actor = sender or receiver — pick pane from role determined above (sender preferred on
      // self-address tasks — cancel is typically a sender action). Derive principalId server-side from
      // that side's pane coordinates.
      const committed = await this.log.append(
        this.envelope(payload, input.callerWorkspaceId, this.derivePrincipalId(task, isSender ? 'from' : 'to', input.callerWorkspaceId), input.idempotencyKey),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.cancel: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      const result: CancelOk = { ok: true, task };
      this.idempotencyRecord(input.taskId, input.idempotencyKey, 'cancel', result);
      return result;
    });
  }

  /**
   * B (panel · completion-evidence design §③ E10) — force-fail entry point for workspace teardown only.
   * When a receiver workspace is removed, non-terminal tasks addressed to that workspace cannot advance
   * (receiver gone). **Intentionally bypasses** `VALID_TRANSITIONS` to commit failed (submitted/input-required→failed
   * is impossible on the graph) — the normal transition API still rejects this transition (entry point is
   * not graph relaxation).
   *
   * Without this, teardown kills tasks only in the renderer cache and never reaches the daemon source
   * of truth → restart restoreFromLog resurrects dead tasks as working/submitted, diverging source of
   * truth from reality (undermines durable-source claim). Called from the daemon boot gate that knows
   * workspace removal (a2a.channel.purgeMembership handler).
   *
   * @returns Number of tasks actually committed to failed.
   */
  async failTasksForWorkspaceRemoved(workspaceId: string, reason: string): Promise<number> {
    // Snapshot then iterate — status may change under lock, avoid mutating Map during iteration.
    const targets = [...this.tasks.values()].filter(
      (t) =>
        t.metadata.to.workspaceId === workspaceId &&
        !(TERMINAL_STATES as readonly string[]).includes(t.status.state),
    );
    let failed = 0;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- per-task serialization (ordering with normal transitions)
      const ok = await this.withTaskLock(target.id, async () => {
        // Idempotent skip if normal transition reached terminal while waiting on lock (prevent double commit).
        const cur = this.tasks.get(target.id);
        if (!cur || (TERMINAL_STATES as readonly string[]).includes(cur.status.state)) return false;
        const payload: A2aTaskTransitionPayload = {
          kind: 'task.transition',
          taskId: target.id,
          to: 'failed',
          timestamp: this.isoNow(),
          forced: 'workspace_removed',
          // Synthetic completion evidence (§③ E10): failure reason only (no items). force-fail is a
          // daemon-native entry point that **intentionally bypasses** the completion-evidence gate (PR-B) —
          // does not call validateCompletionEvidence — commits receiver-gone tasks as-is.
          evidence: { summary: reason, items: [] },
        };
        // Daemon force-fail (teardown): removed receiver workspace as authz anchor; principalId derived
        // server-side from receiver pane (to) coordinates (cur is non-null from guard above).
        const committed = await this.log.append(
          this.envelope(payload, workspaceId, this.derivePrincipalId(cur, 'to', workspaceId)),
        );
        if (!committed) return false;
        this.applyPayload(payload);
        return true;
      });
      if (ok) failed++;
    }
    return failed;
  }

  // ── read ───────────────────────────────────────────────────────────

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  queryTasks(workspaceId: string, filters?: QueryFilters): Task[] {
    const out: Task[] = [];
    for (const task of this.tasks.values()) {
      const isSender = task.metadata.from.workspaceId === workspaceId;
      const isReceiver = task.metadata.to.workspaceId === workspaceId;
      if (!isSender && !isReceiver) continue;
      if (filters?.role === 'user' && !isSender) continue;
      if (filters?.role === 'agent' && !isReceiver) continue;
      if (filters?.status && task.status.state !== filters.status) continue;
      // Incremental cursor (A9): ISO-8601 string lex order = time order. strictly-after.
      if (filters?.updatedSince && !(task.metadata.updatedAt > filters.updatedSince)) continue;
      out.push(task);
    }
    return out;
  }

  /** Observability (tests/debug): current projection task count. */
  get taskCount(): number {
    return this.tasks.size;
  }

  // ── GC (projection level, not log truncation) ────────────────────────────

  /**
   * Remove terminal tasks older than 30 minutes + evict **oldest terminal only** when hard cap exceeded.
   *
   * Unlike a2aSlice (UI cache) GC, **never evicts non-terminal (active) tasks** (panel delta): this is
   * the daemon source-of-truth projection — deleting active tasks loses live work (query/transition
   * returns 'task not found'). If terminal-only eviction cannot meet the cap, projection may exceed the
   * cap — preserving active work is correct; natural concurrent task count is the real bound. Log
   * retention truncation is §9 compaction's job (not here).
   */
  gcTerminalTasks(): void {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (
        (TERMINAL_STATES as readonly string[]).includes(task.status.state) &&
        now - new Date(task.metadata.updatedAt).getTime() > GC_MAX_AGE_MS
      ) {
        this.tasks.delete(id);
        this.idempotency.delete(id);
      }
    }
    if (this.tasks.size <= GC_MAX_TASKS) return;
    let toRemove = this.tasks.size - GC_MAX_TASKS;
    // Terminal tasks only as eviction candidates — never delete active (source-of-truth integrity).
    const terminalOldest = [...this.tasks.values()]
      .filter((t) => (TERMINAL_STATES as readonly string[]).includes(t.status.state))
      .sort((a, b) => new Date(a.metadata.updatedAt).getTime() - new Date(b.metadata.updatedAt).getTime());
    for (const task of terminalOldest) {
      if (toRemove <= 0) break;
      this.tasks.delete(task.id);
      this.idempotency.delete(task.id);
      toRemove--;
    }
  }

  // ── internal ────────────────────────────────────────────────────────────

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private generateTaskId(): string {
    // Same shape as a2aSlice generateId('task') — unique id without coordination.
    return `task-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Assemble makeEnvelope draft (issuance fields owned by append). */
  private envelope(
    payload: unknown,
    verifiedWorkspaceId: string,
    principalId: string,
    idempotencyKey?: string,
  ): EventEnvelopeDraft {
    return makeEnvelope({
      domain: 'a2a',
      payload,
      origin: this.origin,
      authContext: this.buildAuthContext(verifiedWorkspaceId, principalId),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /**
   * Server-derived principalId (§7). Caller explicitly names the actor's **role** (actorSide) —
   * create and sender-cancel use from; transition (receiver-forced), teardown, and receiver-cancel use
   * to. We do not infer role from workspaceId match: on self-address tasks (from.ws === to.ws) both
   * sides share the same ws and inference misidentifies the actor (3-model review consensus — Codex·GLM·Claude).
   *
   * Derivation source is pane coordinates in task.metadata. For transition/cancel, coordinates were stored
   * at create time server-side, so the caller updating state cannot forge them. For create, from coordinates
   * are fresh input for that call but in normal topology are renderer-boundary resolved values (§7:356
   * "senderPtyId→registry" server derivation is not available on the A2A path because the daemon cannot
   * resolve ptyId→pane — S-C2, renderer-owned — coordinate derivation is the daemon-boundary equivalent;
   * unlike the channel path, upstream does not inject registry-resolved principalId). Unpinned pane
   * (ws-level task, headless ClaudeWorker) falls back to verifiedWorkspaceId. principalId is display/routing
   * and audit only — authz is unchanged if derivation is wrong (permission anchor = verifiedWorkspaceId, §7:358).
   */
  private derivePrincipalId(task: Task, actorSide: 'from' | 'to', verifiedWorkspaceId: string): string {
    const addr = task.metadata[actorSide];
    if (addr.paneId) return panePrincipalId(addr.workspaceId, addr.paneId);
    return verifiedWorkspaceId;
  }

  /**
   * Assemble authContext (§7 PR5). verifiedWorkspaceId = server-pinned authz anchor (caller-provided).
   * principalId = display/routing stamp derived by derivePrincipalId. trustTier = fixed 'semi-trusted':
   * A2A task RPC carries no trust signal to distinguish GUI human vs ClaudeWorker we spawned (§7 table
   * trusted/semi-trusted distinction input absent), so conservatively unified at the lower tier (blocks
   * sender claims). Precise tier assignment is follow-up after caller trust signal wiring. trustTier/
   * principalId are display/audit only — no authz impact (§7:358).
   */
  private buildAuthContext(
    verifiedWorkspaceId: string,
    principalId: string,
  ): AuthContext {
    return {
      principalId,
      verifiedWorkspaceId,
      trustTier: 'semi-trusted',
    };
  }

  /**
   * Idempotency keys are stored in separate op namespaces (codex delta): if transition and cancel shared
   * the same (taskId, key) plane, one op's key could replay another op's cached result (e.g. cancel key
   * reused on transition returns CancelOk as TransitionOk).
   */
  private idempotencyHit(
    taskId: string,
    key: string | undefined,
    op: 'transition' | 'cancel',
  ): TransitionOk | CancelOk | undefined {
    if (!key) return undefined;
    return this.idempotency.get(taskId)?.get(`${op}:${key}`);
  }

  private idempotencyRecord(
    taskId: string,
    key: string | undefined,
    op: 'transition' | 'cancel',
    result: TransitionOk | CancelOk,
  ): void {
    if (!key) return;
    let stream = this.idempotency.get(taskId);
    if (!stream) {
      stream = new Map();
      this.idempotency.set(taskId, stream);
    }
    stream.set(`${op}:${key}`, result);
    // LRU: Map preserves insertion order — evict oldest keys when cap exceeded.
    while (stream.size > IDEMPOTENCY_CAP) {
      const oldest = stream.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      stream.delete(oldest);
    }
  }

  /**
   * per-task serialization. Chain fn after prev; swallow errors on the stored chain so the next waiter
   * is not rejected because prev failed (same shape as ChannelService.withChannelLock). Clean up entry
   * when tail settles to bound the locks map.
   */
  private withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(taskId, chain);
    void chain.then(() => {
      if (this.locks.get(taskId) === chain) this.locks.delete(taskId);
    });
    return run;
  }
}
