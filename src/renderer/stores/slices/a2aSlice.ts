import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Task, Message, TaskState, Artifact, AgentSkill, CompletionEvidence } from '../../../shared/types';
import { generateId, validateTransition, TERMINAL_STATES, VALID_TRANSITIONS } from '../../../shared/types';
import { validateCompletionEvidence, normalizeCompletionEvidenceWire } from '../../../shared/completionEvidence';
import type { PaneAddress } from '../../hooks/a2aAddressing';
import { isChannelMentionTask } from '../../hooks/channelMentionFlush';

const GC_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const GC_MAX_TASKS = 500;

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Completion-evidence gate (§6.M PR-B) rejection code → human action hint (design §⑤). Same
 * mapping as daemon enforcement point (A2aTaskService) kept locally on the fallback writer —
 * shared/completionEvidence is immutable aside from comments (schema owned by envelope PR5), so
 * it cannot be extracted to a shared helper.
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

/** Pending approval prompt for an A2A `execute:true` request. */
export interface PendingExecuteApproval {
  approvalId: string;
  taskId: string;
  senderWorkspaceId: string;
  receiverWorkspaceId: string;
  messagePreview: string;
  cwd: string | null;
  /** Epoch ms when the prompt auto-denies. */
  expiresAt: number;
}

export interface A2aSlice {
  // Task store: taskId -> Task
  a2aTasks: Record<string, Task>;

  // Agent skills: workspaceId -> AgentSkill[]
  a2aAgentSkills: Record<string, AgentSkill[] | null>;

  /** Pending execute approvals keyed by approvalId. */
  pendingExecuteApprovals: Record<string, PendingExecuteApproval>;
  pendingExecuteApprovalOrder: string[];
  /** Oldest displayed execute-approval prompt, or null if none. */
  pendingExecuteApproval: PendingExecuteApproval | null;
  /** Global YOLO mode: auto-approve new A2A execute:true requests. */
  a2aAutoApproveExecute: boolean;

  // Actions
  createA2aTask: (task: {
    id?: string;
    title: string;
    // Optional pane-level anchors, passed verbatim into WmuxTaskMetadata. `to`
    // pins the receiver pane (Part A); `from` pins the sender pane (S-C2) so a
    // reply can return to the exact originating pane and history role is computed
    // per-pane. Both optional — a ws-only side keeps the prior behavior.
    from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
    to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string; ptyId?: string };
    history: Message[];
    artifacts: Artifact[];
  }) => string;
  addTaskMessage: (taskId: string, message: Message) => void;
  // P2 (S-C2): `callerAddr` is the caller's verified pane. When present AND the
  // task is pinned to a specific receiver pane (`to.paneId`), the status update
  // is restricted to THAT pane. Absent (headless worker / token client / env-hint
  // fallback) ⇒ ws-granular authz, unchanged.
  //
  // Role (envelope PR4, §6.M C6): with A2A transition source of truth moved to daemon
  // A2aTaskService, this validating writer is **demoted to fallback/contingency for daemon-
  // unavailable/unseeded tasks**. Renderer-local created tasks (channel mentions chmention-*, etc.,
  // not seeded to daemon) and transitions during daemon degrade windows still arrive here — do
  // not remove. Daemon-committed transitions apply only via applyDaemonTaskUpdate (verbatim).
  updateTaskStatus: (taskId: string, state: TaskState, callerWorkspaceId: string, callerAddr?: PaneAddress | null, statusMessage?: Message, evidence?: CompletionEvidence) => { ok: boolean; error?: string };
  /**
   * Verbatim cache apply of daemon commit result (envelope PR4 §5 D11, §6.M design C6).
   *
   * **No re-validation contract**: do not re-run evidence gate OR structural validateTransition —
   * daemon force-fail (E10 teardown, etc.) legitimately commits out-of-graph transitions; cache
   * re-running validateTransition would reject those commits and cause split-brain. Source of
   * truth is daemon log; this store is cache (30min GC redefined as cache GC).
   */
  applyDaemonTaskUpdate: (committed: Task) => void;
  addTaskArtifact: (taskId: string, artifact: Artifact) => void;
  cancelTask: (taskId: string, callerWorkspaceId: string) => { ok: boolean; error?: string };
  queryTasks: (
    workspaceId: string,
    filters?: { status?: TaskState; role?: 'user' | 'agent'; updatedSince?: string },
  ) => Task[];
  getTask: (taskId: string) => Task | undefined;
  setAgentSkills: (workspaceId: string, skills: AgentSkill[]) => void;
  getAgentSkills: (workspaceId: string) => AgentSkill[] | null;
  enqueueExecuteApproval: (approval: PendingExecuteApproval) => void;
  removeExecuteApproval: (approvalId: string) => void;
  setA2aAutoApproveExecute: (enabled: boolean) => void;

  // ── Channel-mention delivery tracking (P1 autoresponse) ──
  /** taskId → true once its nudge was pasted into the pane PTY. Kept OUT of the
   *  Task store so the Task schema stays unchanged; pruned with task GC. */
  channelMentionDelivered: Record<string, boolean>;
  /** Mark a channel-mention task as pasted (idempotency for the Stop flush). */
  markChannelMentionDelivered: (taskId: string) => void;
  /** Undelivered channel-mention tasks (chmention-*, non-terminal) addressed to
   *  this workspace — the queue the Stop/arrival flush drains. */
  getUndeliveredChannelMentionTasks: (workspaceId: string) => Task[];

  // GC
  gcTerminalTasks: () => void;
}

export const createA2aSlice: StateCreator<StoreState, [['zustand/immer', never]], [], A2aSlice> = (set, get) => ({
  a2aTasks: {},
  a2aAgentSkills: {},
  pendingExecuteApprovals: {},
  pendingExecuteApprovalOrder: [],
  pendingExecuteApproval: null,
  a2aAutoApproveExecute: false,
  channelMentionDelivered: {},

  enqueueExecuteApproval: (approval) => set((state: StoreState) => {
    const existing = state.pendingExecuteApprovals[approval.approvalId];
    state.pendingExecuteApprovals[approval.approvalId] = approval;
    if (!existing) state.pendingExecuteApprovalOrder.push(approval.approvalId);
    const firstId = state.pendingExecuteApprovalOrder[0];
    state.pendingExecuteApproval = firstId ? state.pendingExecuteApprovals[firstId] ?? null : null;
  }),

  removeExecuteApproval: (approvalId) => set((state: StoreState) => {
    delete state.pendingExecuteApprovals[approvalId];
    state.pendingExecuteApprovalOrder = state.pendingExecuteApprovalOrder.filter((id) => id !== approvalId);
    const firstId = state.pendingExecuteApprovalOrder[0];
    state.pendingExecuteApproval = firstId ? state.pendingExecuteApprovals[firstId] ?? null : null;
  }),

  setA2aAutoApproveExecute: (enabled) => set((state: StoreState) => {
    state.a2aAutoApproveExecute = enabled;
  }),

  createA2aTask: (input) => {
    const id = input.id ?? generateId('task');
    const now = isoNow();
    set((state: StoreState) => {
      // Idempotent create (A3 — completed-task resurrection). A deterministic id
      // (channel-mention uses `chmention-<channelId>-<seq>`) is a dedup key: a
      // re-delivery (reload, or an autoresponse flush re-firing) calls this again
      // with the SAME id. Overwriting would reset an already working/completed
      // task back to 'submitted' — the agent re-does finished work. If the id is
      // already present, keep the existing task (and its state) untouched.
      if (input.id && state.a2aTasks[input.id]) return;
      state.a2aTasks[id] = {
        kind: 'task',
        id,
        status: { state: 'submitted', timestamp: now },
        history: input.history,
        artifacts: input.artifacts,
        metadata: {
          title: input.title,
          from: input.from,
          to: input.to,
          createdAt: now,
          updatedAt: now,
        },
      };
    });
    return id;
  },

  addTaskMessage: (taskId, message) => set((state: StoreState) => {
    const task = state.a2aTasks[taskId];
    if (task) {
      task.history.push(message);
      task.metadata.updatedAt = isoNow();
    }
  }),

  updateTaskStatus: (taskId, newState, callerWorkspaceId, callerAddr, statusMessage, evidence) => {
    const task = get().a2aTasks[taskId];
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }
    // Permission: only the receiver workspace can update status.
    if (task.metadata.to.workspaceId !== callerWorkspaceId) {
      return { ok: false, error: `Permission denied: caller ${callerWorkspaceId} is not the receiver` };
    }
    // P2 (S-C2) pane-granular authz: when the caller's pane is known (callerAddr
    // present) AND the task is pinned to a specific receiver pane (to.paneId),
    // require the caller to BE that pane — a sibling pane in the receiver ws can
    // no longer drive another pane's task status. INVARIANT: gate on callerAddr
    // ABSENCE, never on to.paneId presence. The headless ClaudeWorker reports
    // working→completed with NO senderPtyId (callerAddr null) yet to.paneId is
    // stored for pane-addressed tasks; gating on to.paneId would reject the
    // worker's completion and hang the task in `working` forever. Absent
    // callerAddr ⇒ ws-authz, unconditionally.
    if (callerAddr && task.metadata.to.paneId && task.metadata.to.paneId !== callerAddr.paneId) {
      return { ok: false, error: `Permission denied: caller pane is not the addressed receiver pane` };
    }
    // Validate state transition. On rejection, surface the allowed next states
    // (read from VALID_TRANSITIONS — the static graph only, never task payload)
    // so the caller learns e.g. that 'submitted' must pass through 'working'
    // before it can 'complete', instead of a bare "Invalid transition".
    if (!validateTransition(task.status.state, newState)) {
      const from = task.status.state;
      const allowed = VALID_TRANSITIONS[from];
      const guidance = allowed.length
        ? `allowed next: [${allowed.join(', ')}]`
        : `'${from}' is a terminal state with no further transitions`;
      return { ok: false, error: `Invalid transition: ${from} -> ${newState}. ${guidance}.` };
    }
    // Completion-evidence normalization (§6.M — structurally parallel to daemon transition, GLM+Claude review):
    // this writer does not trust bridge normalize and re-validates. The sole production caller
    // (useRpcBridge) normalizes first, but future callers bypassing the bridge must not get a
    // different verdict than daemon (malformed rejection) — unknown kind/non-plain objects die
    // as malformed here too; server-only stamps like recordedBy and unknown keys are dropped before store.
    let normalizedEvidence: CompletionEvidence | undefined;
    if (evidence !== undefined) {
      const normalized = normalizeCompletionEvidenceWire(evidence);
      if (!normalized) {
        return { ok: false, error: 'completion_evidence_malformed: evidence must be a plain object with string summary and well-formed items' };
      }
      normalizedEvidence = normalized;
    }
    // Completion-evidence gate (§6.M PR-B — fallback writer). Daemon gate alone is not zero-bypass:
    // pane-pinned tasks + senderPtyId callers are soft-deferred by daemon ('pane-authz deferred'),
    // making this writer the final arbiter (S-C2); same during daemon-unavailable degrade. Mirrors
    // daemon by requiring structured evidence for completed/failed. validateTransition/permission
    // rejection already ran (above), so gate only sees legal transitions. Daemon commit verbatim
    // apply (applyDaemonTaskUpdate) **never gates** (C6 — rejecting force-fail commit = split-brain).
    // Bridge (useRpcBridge) prefixes 'a2a.task.update: ', so return code:hint only.
    if (newState === 'completed' || newState === 'failed') {
      const verdict = validateCompletionEvidence(newState, normalizedEvidence);
      if (!verdict.ok) {
        return { ok: false, error: `${verdict.code}: ${evidenceGateHint(verdict.code)}` };
      }
    }
    set((state: StoreState) => {
      const t = state.a2aTasks[taskId];
      if (t) {
        // additive: store completion evidence on status when transition succeeds (normalize output —
        // gate (PR-B) already decided before set, after validateTransition above).
        t.status = { state: newState, message: statusMessage, timestamp: isoNow(), ...(normalizedEvidence ? { evidence: normalizedEvidence } : {}) };
        t.metadata.updatedAt = isoNow();
      }
    });
    return { ok: true };
  },

  applyDaemonTaskUpdate: (committed) => set((state: StoreState) => {
    // C6 verbatim: re-run neither authz, validateTransition, nor evidence.
    // Daemon A2aTaskService already passed this commit through gates (re-validation = split-brain).
    const existing = state.a2aTasks[committed.id];
    if (existing) {
      // Reflect status/updatedAt verbatim from daemon commit. Preserve renderer-held superset of
      // history/artifacts (daemon projection persists only creation-time history — incremental
      // history persistence is §6.F scope).
      existing.status = committed.status;
      existing.metadata.updatedAt = committed.metadata.updatedAt;
    } else {
      // Cache miss (daemon-restart-surviving task, etc.): accept daemon snapshot wholesale.
      state.a2aTasks[committed.id] = committed;
    }
  }),

  addTaskArtifact: (taskId, artifact) => set((state: StoreState) => {
    const task = state.a2aTasks[taskId];
    if (task) {
      task.artifacts.push(artifact);
      task.metadata.updatedAt = isoNow();
    }
  }),

  cancelTask: (taskId, callerWorkspaceId) => {
    const task = get().a2aTasks[taskId];
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }
    // Permission: sender (cancel own task) or receiver (deny incoming task) can cancel
    const isSender = task.metadata.from.workspaceId === callerWorkspaceId;
    const isReceiver = task.metadata.to.workspaceId === callerWorkspaceId;
    if (!isSender && !isReceiver) {
      return { ok: false, error: `Permission denied: caller ${callerWorkspaceId} is not sender or receiver` };
    }
    // Validate state transition
    if (!validateTransition(task.status.state, 'canceled')) {
      return { ok: false, error: `Cannot cancel task in state: ${task.status.state}` };
    }
    set((state: StoreState) => {
      const t = state.a2aTasks[taskId];
      if (t) {
        t.status = { state: 'canceled', timestamp: isoNow() };
        t.metadata.updatedAt = isoNow();
      }
    });
    return { ok: true };
  },

  queryTasks: (workspaceId, filters) => {
    const tasks = Object.values(get().a2aTasks);
    return tasks.filter((task) => {
      const isSender = task.metadata.from.workspaceId === workspaceId;
      const isReceiver = task.metadata.to.workspaceId === workspaceId;
      if (!isSender && !isReceiver) return false;

      // Role filter: 'user' = sender, 'agent' = receiver
      if (filters?.role === 'user' && !isSender) return false;
      if (filters?.role === 'agent' && !isReceiver) return false;

      // Status filter
      if (filters?.status && task.status.state !== filters.status) return false;

      // Incremental cursor (A9): return only tasks updated AFTER the given
      // ISO-8601 timestamp, so a poller can fetch just what changed instead of
      // re-pulling the whole list. ISO-8601 strings sort lexicographically =
      // chronologically (both sides canonical UTC: stored via isoNow(), the
      // cursor normalized at the RPC entry), so a string compare is the cursor.
      // updatedAt is bumped on every status change / artifact add.
      // LIMITATION (ms precision + strictly-after): two updates within the SAME
      // millisecond share an updatedAt, so a poller that cursors on the first
      // would miss the second. Accepted over the alternative (`>=` re-returns the
      // same timestamp every poll); revisit with a monotonic tie-break if rapid
      // same-ms transitions ever need exact incremental coverage.
      if (filters?.updatedSince && !(task.metadata.updatedAt > filters.updatedSince)) {
        return false;
      }

      return true;
    });
  },

  getTask: (taskId) => {
    return get().a2aTasks[taskId];
  },

  setAgentSkills: (workspaceId, skills) => set((state: StoreState) => {
    state.a2aAgentSkills[workspaceId] = skills;
  }),

  getAgentSkills: (workspaceId) => {
    return get().a2aAgentSkills[workspaceId] ?? null;
  },

  markChannelMentionDelivered: (taskId) => set((state: StoreState) => {
    state.channelMentionDelivered[taskId] = true;
  }),

  getUndeliveredChannelMentionTasks: (workspaceId) => {
    const { a2aTasks, channelMentionDelivered } = get();
    return Object.values(a2aTasks).filter(
      (task) =>
        isChannelMentionTask(task.id) &&
        task.metadata.to.workspaceId === workspaceId &&
        !channelMentionDelivered[task.id] &&
        !(TERMINAL_STATES as readonly string[]).includes(task.status.state),
    );
  },

  gcTerminalTasks: () => set((state: StoreState) => {
    const now = Date.now();
    const taskIds = Object.keys(state.a2aTasks);

    // Remove terminal tasks older than 30 minutes
    for (const id of taskIds) {
      const task = state.a2aTasks[id];
      if (
        task &&
        (TERMINAL_STATES as readonly string[]).includes(task.status.state) &&
        now - new Date(task.metadata.updatedAt).getTime() > GC_MAX_AGE_MS
      ) {
        delete state.a2aTasks[id];
      }
    }

    // If still over the hard cap, evict oldest tasks. Prefer terminal tasks (their data
    // is safe to drop), but fall back to evicting the oldest non-terminal tasks so
    // GC_MAX_TASKS is a TRUE hard bound: a peer that creates tasks and never drives them
    // to a terminal state would otherwise grow a2aTasks without limit, since the
    // age-based prune above only removes terminal tasks.
    const remaining = Object.values(state.a2aTasks);
    if (remaining.length > GC_MAX_TASKS) {
      let toRemove = remaining.length - GC_MAX_TASKS;
      const oldestFirst = [...remaining].sort(
        (a, b) => new Date(a.metadata.updatedAt).getTime() - new Date(b.metadata.updatedAt).getTime(),
      );
      const isTerminal = (t: (typeof remaining)[number]) =>
        (TERMINAL_STATES as readonly string[]).includes(t.status.state);
      // Terminal tasks first (oldest-first), then non-terminal oldest-first as a backstop.
      const evictionOrder = [
        ...oldestFirst.filter(isTerminal),
        ...oldestFirst.filter((t) => !isTerminal(t)),
      ];
      for (const task of evictionOrder) {
        if (toRemove <= 0) break;
        delete state.a2aTasks[task.id];
        toRemove--;
      }
    }

    // Prune delivery markers for tasks that no longer exist (covers every
    // removal path above) so channelMentionDelivered can't grow unbounded.
    for (const id of Object.keys(state.channelMentionDelivered)) {
      if (!state.a2aTasks[id]) delete state.channelMentionDelivered[id];
    }
  }),
});
