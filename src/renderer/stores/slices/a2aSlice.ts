import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Task, Message, TaskState, Artifact, AgentSkill } from '../../../shared/types';
import { generateId, validateTransition, TERMINAL_STATES, VALID_TRANSITIONS } from '../../../shared/types';
import type { PaneAddress } from '../../hooks/a2aAddressing';

const GC_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const GC_MAX_TASKS = 500;

function isoNow(): string {
  return new Date().toISOString();
}

/** Pending approval prompt for an A2A `execute:true` request. */
export interface PendingExecuteApproval {
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

  /** Currently displayed execute-approval prompt, or null if none. */
  pendingExecuteApproval: PendingExecuteApproval | null;

  // Actions
  createA2aTask: (task: {
    title: string;
    // Optional pane-level anchors, passed verbatim into WmuxTaskMetadata. `to`
    // pins the receiver pane (Part A); `from` pins the sender pane (S-C2) so a
    // reply can return to the exact originating pane and history role is computed
    // per-pane. Both optional — a ws-only side keeps the prior behavior.
    from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
    to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
    history: Message[];
    artifacts: Artifact[];
  }) => string;
  addTaskMessage: (taskId: string, message: Message) => void;
  // P2 (S-C2): `callerAddr` is the caller's verified pane. When present AND the
  // task is pinned to a specific receiver pane (`to.paneId`), the status update
  // is restricted to THAT pane. Absent (headless worker / token client / env-hint
  // fallback) ⇒ ws-granular authz, unchanged.
  updateTaskStatus: (taskId: string, state: TaskState, callerWorkspaceId: string, callerAddr?: PaneAddress | null, statusMessage?: Message) => { ok: boolean; error?: string };
  addTaskArtifact: (taskId: string, artifact: Artifact) => void;
  cancelTask: (taskId: string, callerWorkspaceId: string) => { ok: boolean; error?: string };
  queryTasks: (workspaceId: string, filters?: { status?: TaskState; role?: 'user' | 'agent' }) => Task[];
  getTask: (taskId: string) => Task | undefined;
  setAgentSkills: (workspaceId: string, skills: AgentSkill[]) => void;
  getAgentSkills: (workspaceId: string) => AgentSkill[] | null;
  setPendingExecuteApproval: (approval: PendingExecuteApproval | null) => void;

  // GC
  gcTerminalTasks: () => void;
}

export const createA2aSlice: StateCreator<StoreState, [['zustand/immer', never]], [], A2aSlice> = (set, get) => ({
  a2aTasks: {},
  a2aAgentSkills: {},
  pendingExecuteApproval: null,

  setPendingExecuteApproval: (approval) => set((state: StoreState) => {
    state.pendingExecuteApproval = approval;
  }),

  createA2aTask: (input) => {
    const id = generateId('task');
    const now = isoNow();
    set((state: StoreState) => {
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

  updateTaskStatus: (taskId, newState, callerWorkspaceId, callerAddr, statusMessage) => {
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
    set((state: StoreState) => {
      const t = state.a2aTasks[taskId];
      if (t) {
        t.status = { state: newState, message: statusMessage, timestamp: isoNow() };
        t.metadata.updatedAt = isoNow();
      }
    });
    return { ok: true };
  },

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
  }),
});
