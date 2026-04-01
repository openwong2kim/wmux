import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { A2aTask, A2aTaskMessage, A2aTaskStatus, A2aArtifact } from '../../../shared/types';
import { generateId, validateTransition, TERMINAL_STATES } from '../../../shared/types';

const GC_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const GC_MAX_TASKS = 500;

export interface A2aSlice {
  // Task store: taskId -> A2aTask
  a2aTasks: Record<string, A2aTask>;

  // Agent skills: workspaceId -> skills
  a2aAgentSkills: Record<string, string[] | null>;

  // Actions
  createA2aTask: (task: Omit<A2aTask, 'id' | 'createdAt' | 'updatedAt'>) => string;
  addTaskMessage: (taskId: string, message: A2aTaskMessage) => void;
  updateTaskStatus: (taskId: string, status: A2aTaskStatus, callerWorkspaceId: string) => { ok: boolean; error?: string };
  addTaskArtifact: (taskId: string, artifact: A2aArtifact) => void;
  cancelTask: (taskId: string, callerWorkspaceId: string) => { ok: boolean; error?: string };
  queryTasks: (workspaceId: string, filters?: { status?: A2aTaskStatus; role?: 'sender' | 'receiver' }) => A2aTask[];
  getTask: (taskId: string) => A2aTask | undefined;
  setAgentSkills: (workspaceId: string, skills: string[]) => void;
  getAgentSkills: (workspaceId: string) => string[] | null;

  // GC
  gcTerminalTasks: () => void;
}

export const createA2aSlice: StateCreator<StoreState, [['zustand/immer', never]], [], A2aSlice> = (set, get) => ({
  a2aTasks: {},
  a2aAgentSkills: {},

  createA2aTask: (task) => {
    const id = generateId('task');
    const now = Date.now();
    set((state: StoreState) => {
      state.a2aTasks[id] = {
        ...task,
        id,
        status: 'submitted',
        createdAt: now,
        updatedAt: now,
      };
    });
    return id;
  },

  addTaskMessage: (taskId, message) => set((state: StoreState) => {
    const task = state.a2aTasks[taskId];
    if (task) {
      task.messages.push(message);
      task.updatedAt = Date.now();
    }
  }),

  updateTaskStatus: (taskId, status, callerWorkspaceId) => {
    const task = get().a2aTasks[taskId];
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }
    // Permission: only receiver can update status
    if (task.to.workspaceId !== callerWorkspaceId) {
      return { ok: false, error: `Permission denied: caller ${callerWorkspaceId} is not the receiver` };
    }
    // Validate state transition
    if (!validateTransition(task.status, status)) {
      return { ok: false, error: `Invalid transition: ${task.status} -> ${status}` };
    }
    set((state: StoreState) => {
      const t = state.a2aTasks[taskId];
      if (t) {
        t.status = status;
        t.updatedAt = Date.now();
      }
    });
    return { ok: true };
  },

  addTaskArtifact: (taskId, artifact) => set((state: StoreState) => {
    const task = state.a2aTasks[taskId];
    if (task) {
      task.artifacts.push(artifact);
      task.updatedAt = Date.now();
    }
  }),

  cancelTask: (taskId, callerWorkspaceId) => {
    const task = get().a2aTasks[taskId];
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }
    // Permission: only sender can cancel
    if (task.from.workspaceId !== callerWorkspaceId) {
      return { ok: false, error: `Permission denied: caller ${callerWorkspaceId} is not the sender` };
    }
    // Validate state transition
    if (!validateTransition(task.status, 'canceled')) {
      return { ok: false, error: `Cannot cancel task in state: ${task.status}` };
    }
    set((state: StoreState) => {
      const t = state.a2aTasks[taskId];
      if (t) {
        t.status = 'canceled';
        t.updatedAt = Date.now();
      }
    });
    return { ok: true };
  },

  queryTasks: (workspaceId, filters) => {
    const tasks = Object.values(get().a2aTasks);
    return tasks.filter((task) => {
      // Must be related to the workspace (as sender or receiver)
      const isSender = task.from.workspaceId === workspaceId;
      const isReceiver = task.to.workspaceId === workspaceId;
      if (!isSender && !isReceiver) return false;

      // Role filter
      if (filters?.role === 'sender' && !isSender) return false;
      if (filters?.role === 'receiver' && !isReceiver) return false;

      // Status filter
      if (filters?.status && task.status !== filters.status) return false;

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
        (TERMINAL_STATES as readonly string[]).includes(task.status) &&
        now - task.updatedAt > GC_MAX_AGE_MS
      ) {
        delete state.a2aTasks[id];
      }
    }

    // If still over limit, remove oldest terminal tasks first
    const remaining = Object.values(state.a2aTasks);
    if (remaining.length > GC_MAX_TASKS) {
      const terminalTasks = remaining
        .filter((t) => (TERMINAL_STATES as readonly string[]).includes(t.status))
        .sort((a, b) => a.updatedAt - b.updatedAt);

      let toRemove = remaining.length - GC_MAX_TASKS;
      for (const task of terminalTasks) {
        if (toRemove <= 0) break;
        delete state.a2aTasks[task.id];
        toRemove--;
      }
    }
  }),
});
