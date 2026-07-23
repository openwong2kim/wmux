// ─── Mission (WorkTask) renderer cache slice (NB2 wave 2 cycle C) ────────────────
//
// J1 fan-out expands one prompt into N isolated tasks (WorkTask), each with a
// dedicated workspace (`WorkTask.paneGroupId` = that child workspace id).
// This slice caches `task.mission.list` RPC results **per parent workspace** so
// the sidebar "Missions" section and FleetCard can render "missions this workspace fan-out'd".
//
// ── Polling strategy (verified against live code) ─────────────────────────────────────────────
// daemon WorkTaskService emits **no EventBus events at all** (grep confirmed).
// Mission list/status changes are therefore **pure pull**, not pushed to the renderer.
// Fan-out materialization (branch/worktreePath/paneGroupId) is **synchronously committed**
// via task.mission.update before FanOutService.start() returns, so topology is complete
// at fan-out completion. Therefore:
//   - Frequent polling like channel unread (events.poll 1Hz) is unnecessary/overkill — that
//     cadence is for live message delivery; missions only have low-frequency open→closed changes.
//   - Instead: (a) refetch on mount/workspace list changes, (b) refetch right after fan-out,
//     (c) sparse background polling for status drift (open→closed) is enough.
// This judgment lives in useMissionsPolling (this slice owns cache + reverse index only).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { WorkTask } from '../../../shared/workTask';

/** Mission read bridge installed by useRpcBridge (single-method facade). */
interface MissionRpcBridge {
  list: (params: Record<string, unknown>) => Promise<unknown>;
}

function readMissionRpc(): MissionRpcBridge | undefined {
  return (window as unknown as { __wmuxMissionRpc?: MissionRpcBridge }).__wmuxMissionRpc;
}

/**
 * `rpc.invoke` wraps daemon responses in protocol envelope `{ id, ok, result }` (result being
 * the daemon's own `{ ok, tasks }`). Same shape as unwrapRpc in useChannelsHydration — strips
 * the transport envelope to expose the daemon response.
 */
function unwrapRpc(res: unknown): unknown {
  if (
    res !== null &&
    typeof res === 'object' &&
    'result' in res &&
    (res as { result?: unknown }).result !== null &&
    typeof (res as { result?: unknown }).result === 'object'
  ) {
    return (res as { result: unknown }).result;
  }
  return res;
}

function isOkObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && (v as { ok?: unknown }).ok === true;
}

/**
 * Rebuild `paneGroupId → WorkTask` reverse index by scanning all per-parent caches. Total task
 * count is bounded by per-workspace open cap (256) and fan-out cap (8), so full rebuild is
 * cheap (more accurate and simpler than partial updates — no ghost entries after parent delete/refan-out).
 * Tasks without materialized paneGroupId (fan-out in progress) are omitted from the index (optional field).
 */
function rebuildPaneGroupIndex(byWorkspace: Record<string, WorkTask[]>): Record<string, WorkTask> {
  const index: Record<string, WorkTask> = {};
  for (const tasks of Object.values(byWorkspace)) {
    for (const task of tasks) {
      if (task.paneGroupId) index[task.paneGroupId] = task;
    }
  }
  return index;
}

/** J3 §3 — onExhausted toast/resend mapping entry (ptyId → task coordinates). */
export interface TaskPtyEntry {
  taskId: string;
  title: string;
  /** prompt.md resend material (§3 — main checks file existence). Absent when not materialized. */
  worktreePath?: string;
  /** F2 — original initialCommand for resend (agent boot + prompt injection). */
  initialCommand?: string;
}

export interface WorkTaskSlice {
  /** Parent workspace id → cached mission (WorkTask) list owned by that workspace. */
  missionsByWorkspace: Record<string, WorkTask[]>;
  /** paneGroupId (= child workspace id) → WorkTask reverse index (O(1) lookup). */
  missionByPaneGroup: Record<string, WorkTask>;
  /** J3 §3 — ptyId → task coordinates (registered by fan-out result; consumed by onExhausted). */
  taskPtyRegistry: Record<string, TaskPtyEntry>;
  /** J3 §4 — paneGroupId (= task workspace id) → departed cwd (outside boundary). Absent when not departed. */
  departedPaneGroups: Record<string, string>;

  /** Replace one parent's mission list wholesale and rebuild reverse index (source of truth = daemon). */
  setMissions: (parentWorkspaceId: string, tasks: WorkTask[]) => void;
  /** Pull `task.mission.list` via bridge and project into setMissions (best-effort). */
  refreshMissions: (parentWorkspaceId: string) => Promise<void>;
  /** Remove one parent's cache (workspace closed, etc.) and rebuild reverse index. */
  clearMissionsFor: (parentWorkspaceId: string) => void;
  /** Look up mission by paneGroupId (sidebar/FleetCard matching). */
  getMissionForPaneGroup: (paneGroupId: string) => WorkTask | undefined;
  /** J3 §3 — register fan-out (ptyId, task) mapping (for onExhausted toast). */
  registerTaskPtys: (entries: Array<{ ptyId: string } & TaskPtyEntry>) => void;
  /** J3 §4 — set departed state for a task workspace (cwd=null clears). */
  setPaneGroupDeparted: (paneGroupId: string, cwd: string | null) => void;
}

export const createWorkTaskSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  WorkTaskSlice
> = (set, get) => ({
  missionsByWorkspace: {},
  missionByPaneGroup: {},
  taskPtyRegistry: {},
  departedPaneGroups: {},

  registerTaskPtys: (entries) =>
    set((state: StoreState) => {
      for (const e of entries) {
        if (!e.ptyId) continue;
        state.taskPtyRegistry[e.ptyId] = {
          taskId: e.taskId,
          title: e.title,
          ...(e.worktreePath ? { worktreePath: e.worktreePath } : {}),
          ...(e.initialCommand ? { initialCommand: e.initialCommand } : {}),
        };
      }
    }),

  setPaneGroupDeparted: (paneGroupId, cwd) =>
    set((state: StoreState) => {
      if (!paneGroupId) return;
      if (cwd === null) {
        delete state.departedPaneGroups[paneGroupId];
      } else if (state.departedPaneGroups[paneGroupId] !== cwd) {
        state.departedPaneGroups[paneGroupId] = cwd;
      }
    }),

  setMissions: (parentWorkspaceId, tasks) =>
    set((state: StoreState) => {
      state.missionsByWorkspace[parentWorkspaceId] = tasks;
      state.missionByPaneGroup = rebuildPaneGroupIndex(state.missionsByWorkspace);
    }),

  clearMissionsFor: (parentWorkspaceId) =>
    set((state: StoreState) => {
      if (state.missionsByWorkspace[parentWorkspaceId] === undefined) return;
      delete state.missionsByWorkspace[parentWorkspaceId];
      state.missionByPaneGroup = rebuildPaneGroupIndex(state.missionsByWorkspace);
    }),

  refreshMissions: async (parentWorkspaceId) => {
    if (!parentWorkspaceId) return;
    const bridge = readMissionRpc();
    if (!bridge) return; // useRpcBridge installs first (hook order); miss self-heals on next trigger.
    let res: unknown;
    try {
      // Read path: renderer calls without senderPtyId use caller-supplied verifiedWorkspaceId as-is
      // (process-boundary trust — documented remainder in a2a.channel.rpc.ts header).
      res = await bridge.list({ verifiedWorkspaceId: parentWorkspaceId });
    } catch {
      // Daemon disconnected / transient pipe failure — next trigger retries.
      return;
    }
    const env = unwrapRpc(res);
    if (!isOkObject(env)) return;
    const rawTasks = (env as { tasks?: unknown }).tasks;
    if (!Array.isArray(rawTasks)) return;
    get().setMissions(parentWorkspaceId, rawTasks as WorkTask[]);
  },

  getMissionForPaneGroup: (paneGroupId) => {
    if (!paneGroupId) return undefined;
    return get().missionByPaneGroup[paneGroupId];
  },
});
