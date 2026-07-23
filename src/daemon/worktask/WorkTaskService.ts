/**
 * WorkTaskService — daemon-side **source of truth** for WorkTask (mission unit) (J0 §1~§3 D1~D3).
 *
 * Follows A2aTaskService's (daemon/a2a) proven projection-first pattern, with J0 spec
 * differences:
 *   - projection-first: **commit** `task.create`/`task.close` envelopes first
 *     (append→true), then apply to projection only. If append is false, projection
 *     stays unchanged (log is source of truth).
 *   - Exclusivity invariant serialization (at most one open per canonical worktreePath, §2) uses
 *     a **service-wide write mutex**, not per-task locks (GLM review: concurrent create on
 *     different tasks is not protected by per-task locks).
 *   - Fixed boot order (§1 D — Codex): **replay → reconcile (bidirectional) → closed GC**.
 *     If GC runs before reconcile, "closed task + active channel" recovery targets vanish from
 *     projection. Additional safety pin: **GC exempts closed tasks with unconfirmed archive**.
 *   - `(op, idempotencyKey)` LRU idempotency (§4·§3 MCP idempotency) — lost-response retries
 *     cannot create duplicate channels + duplicate tasks.
 *   - Mission channel create/archive calls ChannelService.create/archive inside the daemon
 *     (§3 crash ordering·compensating archive·no-op tolerance contract).
 *
 * Identity (§3): mission.start/close callers are authz'd only via server-resolved
 * senderPtyId→verifiedWorkspaceId (fail-closed). Owner is born-owned: server forces
 * createdBy at creation (§5.1 — not on wire).
 */

import { makeEnvelope } from '../../shared/eventlog';
import type {
  AuthContext,
  EventEnvelope,
  EventEnvelopeDraft,
  TrustTier,
} from '../../shared/eventlog';
import {
  WORKTASK_CLOSED_GC_MS,
  WORKTASK_IDEMPOTENCY_CAP,
  WORKTASK_MAX_OPEN_PER_WORKSPACE,
  WORKTASK_PR_URL_RE,
  missionTopicFor,
  normalizeWorktreePath,
  taskIdFromMissionTopic,
} from '../../shared/workTask';
import type {
  WorkTask,
  WorkTaskClosePayload,
  WorkTaskCreatePayload,
  WorkTaskRef,
  WorkTaskUpdatePayload,
} from '../../shared/workTask';
import { CHANNEL_TOPIC_MAX } from '../../shared/channels';

/** Minimal log interface requiring append + readAllRecords only (same shape as A2aLogLike). */
export interface WorkTaskLogLike {
  append(draft: EventEnvelopeDraft): Promise<boolean>;
  readAllRecords(): EventEnvelope[];
}

/**
 * Requires only the minimal ChannelService create/archive surface used by WorkTaskService
 * (test fakes injectable). Returns typed Result envelope.
 */
export interface WorkTaskChannelPort {
  create(params: {
    name: string;
    visibility: 'public' | 'private';
    topic?: string;
    createdBy: { workspaceId: string; memberId: string; principalId?: string };
    verifiedWorkspaceId: string;
    members?: Array<{ workspaceId: string; memberId: string; principalId?: string }>;
  }): Promise<
    | { ok: true; channel: { id: string } }
    | { ok: false; error: { code: string; message: string } }
  >;
  archive(params: {
    channelId: string;
    archivedBy: string;
    verifiedWorkspaceId: string;
  }): Promise<
    | { ok: true }
    | { ok: false; error: { code: string; message: string } }
  >;
  /** Boot reconcile only — all channels regardless of membership (id, topic, status, founding ws).
   *  createdByWorkspaceId is authz identity for orphan archive (founder is always seeded as
   *  member so passes member gate — 3-model review R1': empty identity archive always fails). */
  listAllForReconcile(): Array<{
    id: string;
    topic?: string;
    status: 'active' | 'archived';
    createdByWorkspaceId?: string;
  }>;
}

export interface WorkTaskServiceOptions {
  log: WorkTaskLogLike;
  channels: WorkTaskChannelPort;
  /** Envelope origin (§8). machineId·daemonEpoch fixed at boot. */
  origin: { machineId: string; daemonEpoch: number };
  /**
   * CEO exception for close authz (§3 — GLM: cites ceoWorkspaceId mechanism). Injected when
   * daemon knows ceoWorkspaceId. If absent, owner gate only.
   */
  ceoWorkspaceId?: string;
  /** GC/timestamp injection (tests). Default Date.now. */
  now?: () => number;
  /**
   * realpath resolver for worktreePath exclusivity invariant (§5). Daemon has no fs access so
   * this is injected (tests = identity; wiring wraps fs.realpathSync fallback). On failure
   * (missing path etc.) returns original so caller can fall back to string normalization only.
   * Adds symlink resolution on top of shared normalizeWorktreePath (pure string normalization).
   */
  realpath?: (p: string) => string;
}

/** mission.start input — router enforces wire whitelist (§2); server identity included here. */
export interface StartMissionInput {
  title: string;
  /** Server-pinned authz anchor (§3 senderPtyId→verifiedWorkspaceId resolution). */
  verifiedWorkspaceId: string;
  /** Creator member id (seeded as member on channel create). */
  memberId: string;
  /** Optional invite list (seeded as initial channel members). */
  invite?: Array<{ workspaceId: string; memberId: string }>;
  /** §3 MCP idempotency key (absorbs lost-response retries). */
  idempotencyKey?: string;
}

export interface CloseMissionInput {
  taskId: string;
  /** Server-pinned authz anchor (§3). */
  verifiedWorkspaceId: string;
  idempotencyKey?: string;
}

/**
 * task.update input (§5 — J0 reserved fulfillment). Wire whitelist is {taskId, branch?,
 * worktreePath?, paneGroupId?} only (prUrl is J2 scope so excluded from J1 wire). Materialization is
 * monotonic — overwrite of already-set fields is refused.
 */
export interface UpdateMissionInput {
  taskId: string;
  /** Server-pinned authz anchor (§5 — same as close: owner OR CEO). */
  verifiedWorkspaceId: string;
  branch?: string;
  worktreePath?: string;
  paneGroupId?: string;
  /** J3 §2: non-monotonic mutable (PR regeneration update allowed) — solo update on closed tasks too. */
  prUrl?: string;
}

export type WorkTaskErr = { ok: false; error: string };
export type StartMissionOk = { ok: true; taskId: string; channelId: string };
export type CloseMissionOk = {
  ok: true;
  taskId: string;
  /** J3 §1(CX2): channel archive unconfirmed — boot reconcile retries to convergence. */
  archivePending?: boolean;
};
export type UpdateMissionOk = { ok: true; taskId: string };

export class WorkTaskService {
  private readonly log: WorkTaskLogLike;
  private readonly channels: WorkTaskChannelPort;
  private readonly origin: { machineId: string; daemonEpoch: number };
  private readonly ceoWorkspaceId: string | undefined;
  private readonly now: () => number;
  /** §5 exclusivity realpath resolver (injected). Default = identity (pure string normalization only). */
  private readonly realpath: (p: string) => string;

  /** projection: taskId → WorkTask (in-memory view of canonical state, rederivable from log). */
  private readonly tasks = new Map<string, WorkTask>();
  /**
   * Service-wide write mutex (§2). Exclusivity invariant (one open per worktreePath) check
   * serialization is insufficient with per-task locks (concurrent create on different tasks).
   * Chains all mutations (create/close) on this single chain.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  /**
   * §4 idempotency: op namespace (start/close) → (idempotencyKey → original result). LRU cap.
   * Lost-response retries cannot create duplicate channels·tasks (§3 R3).
   */
  private readonly idempotency = new Map<string, StartMissionOk | CloseMissionOk>();

  constructor(opts: WorkTaskServiceOptions) {
    this.log = opts.log;
    this.channels = opts.channels;
    this.origin = opts.origin;
    this.ceoWorkspaceId = opts.ceoWorkspaceId;
    this.now = opts.now ?? Date.now;
    this.realpath = opts.realpath ?? ((p) => p);
  }

  // ── Boot restore (fixed order: replay → reconcile → GC) ────────────────────

  /**
   * Boot once. §1 D fixed order: **replay → reconcile (bidirectional) → closed GC**.
   * reconcile may touch channels (archive) so it is async.
   */
  async boot(): Promise<void> {
    this.replay();
    await this.reconcile();
    this.gcClosedTasks();
  }

  /** Replay log `domain:'task'` records in order to restore projection. */
  private replay(): void {
    for (const rec of this.log.readAllRecords()) {
      if (rec.domain !== 'task') continue;
      this.applyPayload(rec.payload);
      this.restoreIdempotency(rec);
    }
  }

  /**
   * Rebuild idempotency LRU on replay so same idempotencyKey retry after restart returns
   * original result (same shape as A2aTaskService.restoreIdempotency). start rebuilds
   * (taskId, channelId), close rebuilds (taskId) as original results.
   * Scope identity restored from envelope authContext server stamp (non-forgeable).
   */
  private restoreIdempotency(rec: EventEnvelope): void {
    if (!rec.idempotencyKey) return;
    const ws = rec.authContext.verifiedWorkspaceId;
    const p = rec.payload as { kind?: unknown; task?: unknown; taskId?: unknown };
    if (p.kind === 'task.create') {
      const task = (p as WorkTaskCreatePayload).task;
      if (task && typeof task.id === 'string' && typeof task.missionChannelId === 'string') {
        this.idempotencyRecord('start', ws, rec.idempotencyKey, {
          ok: true,
          taskId: task.id,
          channelId: task.missionChannelId,
        });
      }
      return;
    }
    if (p.kind === 'task.close') {
      const taskId = (p as WorkTaskClosePayload).taskId;
      if (typeof taskId === 'string') {
        this.idempotencyRecord('close', ws, rec.idempotencyKey, { ok: true, taskId });
      }
    }
  }

  /**
   * Apply payload to projection (only after append success). kind is closed union so
   * unknown kind is safely ignored (fail-closed).
   */
  private applyPayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as { kind?: unknown };
    if (p.kind === 'task.create') {
      const { task } = payload as WorkTaskCreatePayload;
      if (task && typeof task.id === 'string' && !this.tasks.has(task.id)) {
        this.tasks.set(task.id, task);
      }
      return;
    }
    if (p.kind === 'task.close') {
      const c = payload as WorkTaskClosePayload;
      const task = this.tasks.get(c.taskId);
      if (!task || task.status === 'closed') return;
      task.status = 'closed';
      task.closedAt = c.closedAt;
      return;
    }
    if (p.kind === 'task.update') {
      // J1 §5: monotonic materialization field commit. replay/runtime both reflect via this path.
      // Monotonicity (first write only)·exclusivity·authz gated by updateMission before append
      // **before** append — applyPayload is pure applier of committed records so only
      // overwrites present fields (legacy record safe: absent fields unchanged).
      const u = payload as WorkTaskUpdatePayload;
      const task = this.tasks.get(u.taskId);
      if (!task) return;
      if (task.status === 'closed') {
        // J3 §2: closed tasks only get prUrl (gate rejects materialization before append,
        // but applier uses same filter for replay safety).
        if (u.prUrl !== undefined) task.prUrl = u.prUrl;
        return;
      }
      if (u.branch !== undefined) task.branch = u.branch;
      if (u.worktreePath !== undefined) task.worktreePath = u.worktreePath;
      if (u.paneGroupId !== undefined) task.paneGroupId = u.paneGroupId;
      if (u.prUrl !== undefined) task.prUrl = u.prUrl;
      return;
    }
  }

  /**
   * Bidirectional reconcile (§3 — Codex+GLM). After replay, reconcile projection with channel state:
   *   - Channel direction (orphan): topic anchors `wmux:mission:{taskId}` but taskId not in
   *     projection → orphan → archive (crash window 1↔2 compensation). Forged topic channels
   *     (user manual create) also archived when no task (§6 self-harm limited).
   *   - Task direction (closed+active): closed task's mission channel still active →
   *     retry archive (idempotent — no-op if already archived/absent).
   */
  private async reconcile(): Promise<void> {
    const channels = this.channels.listAllForReconcile();
    const byId = new Map(channels.map((c) => [c.id, c]));

    // Channel direction: archive orphan mission-topic channels.
    for (const ch of channels) {
      if (ch.status === 'archived') continue;
      const anchoredTaskId = taskIdFromMissionTopic(ch.topic);
      if (!anchoredTaskId) continue;
      if (this.tasks.has(anchoredTaskId)) continue; // normal binding — present in projection.
      // Orphan: daemon-internal archive. Identity = channel creator workspace (3-model review R1' —
      // creator always seeded as member on create so passes member gate. Empty
      // identity ('') loses isMember/isCeo so all orphan archives swallowed as no-op and
      // persisted forever). Best-effort fallback if creator ws missing from record (legacy).
      await this.tryArchive(ch.id, ch.createdByWorkspaceId ?? '');
    }

    // Task direction: closed but channel active → retry archive.
    for (const task of this.tasks.values()) {
      if (task.status !== 'closed') continue;
      const ch = byId.get(task.missionChannelId);
      if (!ch || ch.status === 'archived') continue; // absent/already archived = no-op.
      await this.tryArchive(task.missionChannelId, task.owner.verifiedWorkspaceId);
    }
  }

  /**
   * Evict tasks from projection after closedAt + WORKTASK_CLOSED_GC_MS (§1 D13).
   * In-memory view bound, not log truncation (§6.L compaction scope unchanged).
   *
   * **Intentionally no** "unconfirmed archive closed GC exemption" safety pin (review
   * GLM R3', replaces design v1.1 §1 safety pin wording): boot order replay → reconcile
   * → GC is fixed so at GC time this boot's archive retries already finished, and next
   * boot replay restores all tasks from log so GC cannot break recovery path.
   * Conversely, active-channel exemption would leave closed tasks permanently in projection
   * from owner-leave tolerance residue (§3), voiding GC's purpose (view bound).
   */
  gcClosedTasks(): void {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (task.status !== 'closed' || task.closedAt === undefined) continue;
      if (now - task.closedAt <= WORKTASK_CLOSED_GC_MS) continue;
      this.tasks.delete(id);
    }
  }

  // ── mutation ───────────────────────────────────────────────────────

  /**
   * mission.start (§3): pre-issue taskId → channel create → task.create append → projection seed.
   *   - append failure (not crash) → **immediate compensating archive** (§3 — reaper cannot pick orphans).
   *   - crash window (1↔2) → boot reconcile channel direction picks up.
   */
  startMission(input: StartMissionInput): Promise<StartMissionOk | WorkTaskErr> {
    return this.withWriteLock(async () => {
      // §3 idempotency: lost-response retry returns stored result (no append).
      // Key scoped to caller's server-pinned workspace (2-model review R2' — unscoped
      // global key lets other workspace receive {taskId, channelId} with same key).
      const cached = this.idempotencyHit('start', input.verifiedWorkspaceId, input.idempotencyKey);
      if (cached) return cached as StartMissionOk;

      const title = input.title.trim();
      if (title.length === 0) {
        return { ok: false, error: 'task.mission.start: title is required' };
      }
      // Cap: reuse channel topic cap (§2).
      if (title.length > CHANNEL_TOPIC_MAX) {
        return { ok: false, error: `task.mission.start: title exceeds ${CHANNEL_TOPIC_MAX} characters` };
      }
      // DoS cap: open task limit per workspace (§2·§6).
      const openCount = [...this.tasks.values()].filter(
        (t) => t.status === 'open' && t.owner.verifiedWorkspaceId === input.verifiedWorkspaceId,
      ).length;
      if (openCount >= WORKTASK_MAX_OPEN_PER_WORKSPACE) {
        return {
          ok: false,
          error: `task.mission.start: open mission limit reached (${WORKTASK_MAX_OPEN_PER_WORKSPACE}) for this workspace`,
        };
      }

      // 0. Server pre-issue taskId (§3.1 needed for topic pre-anchor).
      const taskId = this.generateTaskId();
      const nowMs = this.now();

      // 1. Mission channel create (§3.1) — pre-anchor topic. Channel first (reverse order
      //    creates task without channel and breaks J1 floor).
      const channelResult = await this.channels.create({
        name: this.missionChannelName(title, taskId),
        visibility: 'private',
        topic: missionTopicFor(taskId),
        createdBy: { workspaceId: input.verifiedWorkspaceId, memberId: input.memberId },
        verifiedWorkspaceId: input.verifiedWorkspaceId,
        ...(input.invite && input.invite.length > 0
          ? { members: input.invite.map((m) => ({ workspaceId: m.workspaceId, memberId: m.memberId })) }
          : {}),
      });
      if (!channelResult.ok) {
        return {
          ok: false,
          error: `task.mission.start: mission channel create failed: ${channelResult.error.code}: ${channelResult.error.message}`,
        };
      }
      const channelId = channelResult.channel.id;

      // 2. task.create envelope append → projection seed.
      const ref: WorkTaskRef = {
        principalId: input.verifiedWorkspaceId,
        verifiedWorkspaceId: input.verifiedWorkspaceId,
      };
      const task: WorkTask = {
        id: taskId,
        title,
        status: 'open',
        missionChannelId: channelId,
        createdAt: nowMs,
        createdBy: ref,
        owner: ref, // §5.1 born-owned: server forces via createdBy.
      };
      const payload: WorkTaskCreatePayload = { kind: 'task.create', task };
      const committed = await this.log.append(
        this.envelope(payload, input.verifiedWorkspaceId, input.idempotencyKey),
      );
      if (!committed) {
        // §3 failure compensation: append false (not crash) → immediately archive channel from step 1.
        // empty-channel reaper cannot pick orphans (creator member remains memberCount>0).
        await this.tryArchive(channelId, input.verifiedWorkspaceId);
        return { ok: false, error: 'task.mission.start: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      const result: StartMissionOk = { ok: true, taskId, channelId };
      this.idempotencyRecord('start', input.verifiedWorkspaceId, input.idempotencyKey, result);
      return result;
    });
  }

  /**
   * mission.close (§3): authz gate (owner OR CEO) → task.close append → apply projection
   * → mission channel archive (idempotent·no-op tolerant).
   *   - re-close: already closed → idempotent no-op ack (§3 GLM — not error).
   *   - channel state unconditional tolerance: already archived/absent/reaper loss → archive no-op.
   */
  closeMission(input: CloseMissionInput): Promise<CloseMissionOk | WorkTaskErr> {
    return this.withWriteLock(async () => {
      // §3 idempotency: absorb lost-response retry (workspace scope — R2'). Even on cache hit,
      // treat as miss if request taskId mismatches (2-model review: same caller reusing key
      // to close different task — returning prior success receipt would silently skip
      // requested close — route through authz·existence validation).
      const cached = this.idempotencyHit('close', input.verifiedWorkspaceId, input.idempotencyKey);
      if (cached && (cached as CloseMissionOk).taskId === input.taskId) {
        return cached as CloseMissionOk;
      }

      const task = this.tasks.get(input.taskId);
      if (!task) {
        return { ok: false, error: `task.mission.close: task not found: ${input.taskId}` };
      }
      // authz (§3): owner OR CEO. Task gate is first defense (not channel gate).
      const isOwner = task.owner.verifiedWorkspaceId === input.verifiedWorkspaceId;
      const isCeo =
        this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === input.verifiedWorkspaceId;
      if (!isOwner && !isCeo) {
        return {
          ok: false,
          error: `task.mission.close: caller ${input.verifiedWorkspaceId} is not the task owner or CEO`,
        };
      }
      // re-close: already closed → idempotent no-op ack. No archive retry
      // (boot reconcile task direction handles) — caller gets success for established close.
      if (task.status === 'closed') {
        const result: CloseMissionOk = { ok: true, taskId: task.id };
        this.idempotencyRecord('close', input.verifiedWorkspaceId, input.idempotencyKey, result);
        return result;
      }

      // 1. task.close envelope append → apply projection.
      const closedAt = this.now();
      const payload: WorkTaskClosePayload = { kind: 'task.close', taskId: task.id, closedAt };
      const committed = await this.log.append(
        this.envelope(payload, input.verifiedWorkspaceId, input.idempotencyKey),
      );
      if (!committed) {
        return { ok: false, error: 'task.mission.close: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      // 2. Mission channel archive — daemon-internal (owner identity). Failure tolerant: already archived/
      //    absent/reaper loss → no-op. close itself stands (log committed) so archive
      //    failure does not undo close (§3 owner-leave tolerance residue + reaper scope).
      const archived = await this.tryArchive(task.missionChannelId, task.owner.verifiedWorkspaceId);

      const result: CloseMissionOk = {
        ok: true,
        taskId: task.id,
        ...(archived ? {} : { archivePending: true }),
      };
      this.idempotencyRecord('close', input.verifiedWorkspaceId, input.idempotencyKey, result);
      return result;
    });
  }

  /**
   * task.update (§5 — J0 reserved fulfillment): monotonic materialization field commit. Gate order:
   *   1. Existence·open check (reject closed — materialization only on live tasks).
   *   2. authz (owner OR CEO — mirror close). Materialization is owner action.
   *   3. Monotonicity: refuse overwrite of already-set branch/worktreePath/paneGroupId
   *      (same value rewrite allowed as idempotent no-op — retry absorption).
   *   4. worktreePath exclusivity: after canonical (realpath+normalize), reject if **other**
   *      open task has same path. Checked under global write mutex so concurrent update on
   *      different tasks cannot double-claim same path.
   * On pass: task.update envelope append → apply projection.
   */
  updateMission(input: UpdateMissionInput): Promise<UpdateMissionOk | WorkTaskErr> {
    return this.withWriteLock(async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) {
        return { ok: false, error: `task.mission.update: task not found: ${input.taskId}` };
      }
      if (task.status === 'closed') {
        // J3 §2 (review CX6): closed tasks allow prUrl-only update — PR can be created after
        // close. Reject when materialization fields accompany as before.
        const hasMaterialization =
          input.branch !== undefined ||
          input.worktreePath !== undefined ||
          input.paneGroupId !== undefined;
        if (hasMaterialization || input.prUrl === undefined) {
          return { ok: false, error: `task.mission.update: task is closed: ${input.taskId}` };
        }
      }
      // authz (§5): owner OR CEO — same anchor as close gate.
      const isOwner = task.owner.verifiedWorkspaceId === input.verifiedWorkspaceId;
      const isCeo =
        this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === input.verifiedWorkspaceId;
      if (!isOwner && !isCeo) {
        return {
          ok: false,
          error: `task.mission.update: caller ${input.verifiedWorkspaceId} is not the task owner or CEO`,
        };
      }

      // prUrl format gate (J3 §2 — review G5): GitHub PR URL only. Non-monotonic so
      // no write-once defense — format is sole wire defense line.
      if (input.prUrl !== undefined && !WORKTASK_PR_URL_RE.test(input.prUrl)) {
        return {
          ok: false,
          error: `task.mission.update: prUrl must match https://github.com/{owner}/{repo}/pull/{n}`,
        };
      }

      // Monotonicity gate: refuse overwriting already-materialized fields with different values.
      // Same value passes (idempotent retry — no-op fields removed in patch assembly below).
      const monotonicViolation = (
        field: 'branch' | 'worktreePath' | 'paneGroupId',
        next: string | undefined,
      ): string | null => {
        if (next === undefined) return null;
        const cur = task[field];
        if (cur !== undefined && cur !== next) {
          return `task.mission.update: ${field} is already materialized (monotonic; overwrite refused)`;
        }
        return null;
      };
      for (const [field, next] of [
        ['branch', input.branch],
        ['worktreePath', input.worktreePath],
        ['paneGroupId', input.paneGroupId],
      ] as const) {
        const err = monotonicViolation(field, next);
        if (err) return { ok: false, error: err };
      }

      // Exclusivity (§5): on new worktreePath, normalize to canonical and check other open
      // tasks. Self with same value already passed monotonic gate above — only filter
      // new-set case and compare against other tasks.
      const isNewWorktreePath =
        input.worktreePath !== undefined && task.worktreePath === undefined;
      if (isNewWorktreePath) {
        const canonical = this.canonicalWorktreePath(input.worktreePath as string);
        for (const other of this.tasks.values()) {
          if (other.id === task.id) continue;
          if (other.status !== 'open') continue;
          if (other.worktreePath === undefined) continue;
          if (this.canonicalWorktreePath(other.worktreePath) === canonical) {
            return {
              ok: false,
              error: `task.mission.update: worktreePath already claimed by open task ${other.id}`,
            };
          }
        }
      }

      // Patch assembly: only actual changes (new values). Exclude same-value rewrites to avoid
      // polluting log with no-op records.
      const patch: WorkTaskUpdatePayload = { kind: 'task.update', taskId: task.id };
      let changed = false;
      if (input.branch !== undefined && task.branch === undefined) {
        patch.branch = input.branch;
        changed = true;
      }
      if (input.worktreePath !== undefined && task.worktreePath === undefined) {
        patch.worktreePath = input.worktreePath;
        changed = true;
      }
      if (input.paneGroupId !== undefined && task.paneGroupId === undefined) {
        patch.paneGroupId = input.paneGroupId;
        changed = true;
      }
      // prUrl (J3 §2): non-monotonic — update when differs from current (same value = no-op).
      if (input.prUrl !== undefined && task.prUrl !== input.prUrl) {
        patch.prUrl = input.prUrl;
        changed = true;
      }
      // No changes (all same-value retry) = idempotent success no-op (no append).
      if (!changed) {
        return { ok: true, taskId: task.id };
      }

      const committed = await this.log.append(
        this.envelope(patch, input.verifiedWorkspaceId),
      );
      if (!committed) {
        return { ok: false, error: 'task.mission.update: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(patch);
      return { ok: true, taskId: task.id };
    });
  }

  // ── read ───────────────────────────────────────────────────────────

  /** task.mission.list (§3): missions where caller is owner (J0 pipe RPC only). */
  listMissions(verifiedWorkspaceId: string): WorkTask[] {
    const out: WorkTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.owner.verifiedWorkspaceId === verifiedWorkspaceId) out.push(task);
    }
    return out;
  }

  getTask(taskId: string): WorkTask | undefined {
    return this.tasks.get(taskId);
  }

  /** For observation (tests/debug): current projection task count. */
  get taskCount(): number {
    return this.tasks.size;
  }

  // ── internal ────────────────────────────────────────────────────────────

  /**
   * Attempt archive (idempotent·tolerant). CHANNEL_NOT_FOUND / already archived = no-op (§3 R5).
   * NOT_AUTHORIZED (owner-leave tolerance residue)·PERSIST_FAILED also swallowed — boot/close
   * paths must not let archive failure undo canonical (task log).
   */
  private async tryArchive(channelId: string, verifiedWorkspaceId: string): Promise<boolean> {
    try {
      const res = await this.channels.archive({
        channelId,
        archivedBy: verifiedWorkspaceId,
        verifiedWorkspaceId,
      });
      // Treat all success·failure codes as harmless — CHANNEL_NOT_FOUND/already archived/
      // NOT_AUTHORIZED are no-op per §3 contract. Return only confirmed status (J3 CX2:
      // if unconfirmed, close response shows archivePending — boot reconcile converges).
      return res.ok === true;
    } catch {
      // Swallow channel service exceptions too — task integrity does not depend on channel existence.
      return false;
    }
  }

  /** Mission channel name `mission-{slug}-{shortId}` (§3.1 — collision absorbed by shortId). */
  private missionChannelName(title: string, taskId: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    // shortId is **last** 8 chars of taskId (= random segment). First 8 chars are now().toString(36)
    // timestamp (exactly 8 chars at current epoch) with zero entropy — two starts with same ms·title
    // produce identical channel name and self-DoS via duplicate rejection (review Claude R4').
    const shortId = taskId.replace(/^wtask-/, '').slice(-8);
    const base = slug.length > 0 ? `mission-${slug}-${shortId}` : `mission-${shortId}`;
    // Channel name rule: must start with lowercase/digit. slug starting with digit·hyphen is safe via 'mission-' prefix.
    return base.slice(0, 64);
  }

  private generateTaskId(): string {
    return `wtask-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Canonical form of worktreePath (§5 exclusivity comparison key). Apply symlink resolution (realpath —
   * injected, original on failure) then fold with pure string normalization (shared).
   * Collapses same checkout via different notation·symlink paths.
   */
  private canonicalWorktreePath(raw: string): string {
    let resolved = raw;
    try {
      resolved = this.realpath(raw);
    } catch {
      // realpath failure (missing path etc.) — fall back to string normalization only.
    }
    return normalizeWorktreePath(resolved);
  }

  /** Assemble makeEnvelope draft (issued fields owned by append). trustTier conservative same as channel·A2A. */
  private envelope(
    payload: unknown,
    verifiedWorkspaceId: string,
    idempotencyKey?: string,
  ): EventEnvelopeDraft {
    return makeEnvelope({
      domain: 'task',
      payload,
      origin: this.origin,
      authContext: this.buildAuthContext(verifiedWorkspaceId),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  private buildAuthContext(verifiedWorkspaceId: string): AuthContext {
    const trustTier: TrustTier = 'semi-trusted';
    return {
      // principalId is display/routing/audit only (not authz) — J0 stamps by workspace.
      principalId: verifiedWorkspaceId,
      verifiedWorkspaceId,
      trustTier,
    };
  }

  /**
   * Idempotency key is `{op}:{verifiedWorkspaceId}:{key}` — namespaced to caller's server-pinned workspace
   * (2-model review R2'). Unscoped global key ① lets other workspace receive
   * same-key {taskId, channelId} result (private channel id leak) and ② close cache hit
   * returns before owner gate bypassing authz. Same class of problem A2aTaskService blocks
   * with (taskId, key) primary scope.
   */
  private idempotencyHit(
    op: 'start' | 'close',
    verifiedWorkspaceId: string,
    key: string | undefined,
  ): StartMissionOk | CloseMissionOk | undefined {
    if (!key) return undefined;
    return this.idempotency.get(`${op}:${verifiedWorkspaceId}:${key}`);
  }

  private idempotencyRecord(
    op: 'start' | 'close',
    verifiedWorkspaceId: string,
    key: string | undefined,
    result: StartMissionOk | CloseMissionOk,
  ): void {
    if (!key) return;
    this.idempotency.set(`${op}:${verifiedWorkspaceId}:${key}`, result);
    // LRU: Map preserves insertion order — evict oldest keys when over cap.
    while (this.idempotency.size > WORKTASK_IDEMPOTENCY_CAP) {
      const oldest = this.idempotency.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.idempotency.delete(oldest);
    }
  }

  /**
   * Service-wide write serialization (§2). Same shape as A2aTaskService.withTaskLock but no key
   * (single chain) — exclusivity check must see concurrent create on different tasks.
   */
  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// normalizeWorktreePath is §2 exclusivity (J1 active) normalization util — re-exported here so
// daemon-side consumers need not know shared path (contract cohesion).
export { normalizeWorktreePath };
