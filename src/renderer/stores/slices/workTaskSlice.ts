// ─── 미션(WorkTask) 렌더러 캐시 슬라이스 (NB2 파동2 사이클 C) ────────────────
//
// J1 fan-out은 프롬프트 1개를 N개의 격리 태스크(WorkTask)로 펼치고, 각 태스크에
// 전용 워크스페이스를 만든다(`WorkTask.paneGroupId` = 그 자식 워크스페이스 id).
// 이 슬라이스는 `task.mission.list` RPC 결과를 **부모 워크스페이스별로** 캐싱해,
// 사이드바 "Missions" 섹션과 FleetCard가 "이 워크스페이스가 fan-out한 미션"을
// 그릴 수 있게 한다.
//
// ── 폴링 방식 판단(실코드 확인) ─────────────────────────────────────────────
// daemon WorkTaskService는 EventBus에 **아무 이벤트도 emit하지 않는다**(grep 확인).
// 즉 미션 목록/상태 변화는 렌더러로 push되지 않는 **순수 pull**이다. 반면 fan-out
// 물질화(branch/worktreePath/paneGroupId)는 FanOutService.start()가 반환하기 전에
// task.mission.update로 **동기 커밋**되므로, fan-out 완료 시점엔 토폴로지가 이미
// 완결돼 있다. 따라서:
//   - 채널 unread(events.poll 1Hz)처럼 잦은 폴링은 불필요·과함 — 그 주기는 라이브
//     메시지 배달용이고, 미션은 저빈도 상태(open→closed) 변화뿐이다.
//   - 대신 (a) 마운트/워크스페이스 목록 변화 시 refetch, (b) fan-out 완료 직후
//     refetch, (c) 상태 드리프트(open→closed)를 위한 성긴 배경 폴링으로 충분하다.
// 이 판단은 useMissionsPolling 훅에 구현한다(이 슬라이스는 캐시·역인덱스만 소유).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { WorkTask } from '../../../shared/workTask';

/** The mission bridge useRpcBridge installs (reads + the close used for workspace-lifetime binding). */
interface MissionRpcBridge {
  list: (params: Record<string, unknown>) => Promise<unknown>;
  close?: (params: Record<string, unknown>) => Promise<unknown>;
}

function readMissionRpc(): MissionRpcBridge | undefined {
  return (window as unknown as { __wmuxMissionRpc?: MissionRpcBridge }).__wmuxMissionRpc;
}

/**
 * `rpc.invoke`는 데몬 응답을 프로토콜 봉투 `{ id, ok, result }`로 감싼다(result가
 * 데몬 자신의 `{ ok, tasks }`). useChannelsHydration의 unwrapRpc와 동형 — 전송
 * 봉투를 벗겨 데몬 응답을 노출한다.
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
 * 모든 부모별 캐시를 훑어 `paneGroupId → WorkTask` 역인덱스를 재구성한다. 태스크
 * 총량은 워크스페이스당 open 캡(256)·fan-out 캡(8)으로 바운드되므로 전량 재구성이
 * 저렴하다(부분 갱신보다 정확하고 단순 — 부모 삭제/재fan-out 시 유령 항목 없음).
 * paneGroupId 미물질화(fan-out 진행 중) 태스크는 인덱스에서 빠진다(옵셔널 필드).
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

/**
 * Is this list the same tasks in the same states as the one already cached?
 * Exported for the test: it is the whole reason the 15 s mission poll stopped
 * re-rendering the deck.
 *
 * Compares the fields any consumer renders or navigates by — a change the UI
 * cannot see is not a change worth a new array identity. `updatedAt` is not a
 * WorkTask field, so a same-shaped list IS the same list to every reader.
 */
export function sameMissionList(
  previous: readonly WorkTask[] | undefined,
  next: readonly WorkTask[],
): boolean {
  if (previous === next) return true;
  if (!previous || previous.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    const a = previous[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.title !== b.title ||
      a.missionChannelId !== b.missionChannelId ||
      a.paneGroupId !== b.paneGroupId ||
      a.createdAt !== b.createdAt ||
      a.closedAt !== b.closedAt ||
      a.detachedAt !== b.detachedAt ||
      a.branch !== b.branch ||
      a.worktreePath !== b.worktreePath ||
      a.prUrl !== b.prUrl
    ) {
      return false;
    }
  }
  return true;
}

/** J3 §3 — onExhausted 토스트/재발사 매핑 항목(ptyId → 태스크 좌표). */
export interface TaskPtyEntry {
  taskId: string;
  title: string;
  /** prompt.md 재발사 재료(§3 — main이 파일 실존 검사). 미물질화면 부재. */
  worktreePath?: string;
  /** F2 — 재발사가 재전송할 원래 initialCommand(에이전트 기동+프롬프트 주입). */
  initialCommand?: string;
}

export interface WorkTaskSlice {
  /** 부모 워크스페이스 id → 그 워크스페이스가 owner인 미션(WorkTask) 목록 캐시. */
  missionsByWorkspace: Record<string, WorkTask[]>;
  /** paneGroupId(=자식 워크스페이스 id) → WorkTask 역인덱스(O(1) 조회). */
  missionByPaneGroup: Record<string, WorkTask>;
  /** J3 §3 — ptyId → 태스크 좌표(fan-out 결과가 등록. onExhausted 소비용). */
  taskPtyRegistry: Record<string, TaskPtyEntry>;
  /** J3 §4 — paneGroupId(=태스크 워크스페이스 id) → 이탈한 cwd(경계 밖). 없으면 부재. */
  departedPaneGroups: Record<string, string>;

  /** 한 부모의 미션 목록을 통째로 교체하고 역인덱스를 재구성한다(정본=데몬). */
  setMissions: (parentWorkspaceId: string, tasks: WorkTask[]) => void;
  /** 브리지 경유로 `task.mission.list`를 당겨 setMissions에 투영(best-effort). */
  refreshMissions: (parentWorkspaceId: string) => Promise<void>;
  /** 한 부모의 캐시를 제거(워크스페이스 닫힘 등) 후 역인덱스 재구성. */
  clearMissionsFor: (parentWorkspaceId: string) => void;
  /** paneGroupId로 미션 조회(사이드바/FleetCard 매칭). */
  getMissionForPaneGroup: (paneGroupId: string) => WorkTask | undefined;
  /** J3 §3 — fan-out 결과의 (ptyId,태스크) 매핑을 등록(onExhausted 토스트용). */
  registerTaskPtys: (entries: Array<{ ptyId: string } & TaskPtyEntry>) => void;
  /** J3 §4 — 태스크 워크스페이스의 이탈 상태 설정(cwd=null이면 해제). */
  setPaneGroupDeparted: (paneGroupId: string, cwd: string | null) => void;
  /**
   * Closes the mission of a task workspace when that workspace is deleted
   * (workspace-lifetime binding). The daemon's close archives the mission channel,
   * so as the workspace disappears the mission row drops out of the list and the
   * channel folds down into the Archived group at the same time —
   * **the channel is never destroyed** (the record is preserved). Best-effort: a
   * failure is harmless because the sidebar's visibility rule looks only at workspace
   * existence, and the next boot reconcile converges.
   */
  closeMissionForRemovedWorkspace: (paneGroupId: string) => Promise<void>;
  /**
   * Detaches a dependent child task from its parent (non-destructive close):
   * the mission is closed with a `workspace-detached` marker so the parent stops
   * tracking it, while the child's **workspace, worktree, branch, PTY and running
   * agent are left completely untouched** — it keeps running, just independently.
   * The daemon archives the mission channel (records preserved, not destroyed),
   * the same as an ordinary close. Returns true on success. Best-effort refresh
   * of the local cache follows. Only open, still-materialized child tasks qualify.
   */
  detachMissionForPaneGroup: (paneGroupId: string) => Promise<boolean>;
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
      // The 15 s poll re-lists the same tasks and used to write a fresh array
      // every time, so `missionsByWorkspace` changed identity on every tick and
      // every consumer memoizing on it (the deck's channel map, the sidebar
      // summary) recomputed and re-rendered for nothing. Content-equal writes
      // are dropped; a real transition still lands.
      if (sameMissionList(state.missionsByWorkspace[parentWorkspaceId], tasks)) return;
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
    if (!bridge) return; // useRpcBridge가 먼저 설치한다(훅 순서); 미스는 다음 트리거에 자가치유.
    let res: unknown;
    try {
      // 읽기 경로: senderPtyId 없는 렌더러 호출은 caller-supplied verifiedWorkspaceId를
      // 그대로 쓴다(프로세스 경계 신뢰 — a2a.channel.rpc.ts 헤더의 문서화된 잔여).
      res = await bridge.list({ verifiedWorkspaceId: parentWorkspaceId });
    } catch {
      // 데몬 미연결/일시 파이프 실패 — 다음 트리거가 재시도.
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

  closeMissionForRemovedWorkspace: async (paneGroupId) => {
    if (!paneGroupId) return;
    const task = get().missionByPaneGroup[paneGroupId];
    if (!task || task.status !== 'open') return; // Absent / already closed = no-op.
    const bridge = readMissionRpc();
    if (!bridge?.close) return;
    let res: unknown;
    try {
      // The authz anchor is the task owner (daemon gate: owner OR CEO). The owner is the
      // **parent**, not the deleted child workspace — calling with the child id is NOT_AUTHORIZED.
      res = await bridge.close({
        taskId: task.id,
        verifiedWorkspaceId: task.owner.verifiedWorkspaceId,
      });
    } catch {
      // Daemon not connected / transient failure — the boot reconcile converges
      // (it retries the archive from the task side).
      return;
    }
    // **Check** the response: this call used to be fire-and-forget, so a rejection
    // vanished silently (that is why a 100% NOT_AUTHORIZED failure was symptomless).
    // Still do not throw — the sidebar's visibility rule looks only at workspace
    // existence, so the screen is correct even when this fails.
    if (!isOkObject(unwrapRpc(res))) {
      console.warn('[workTaskSlice] mission close rejected for task', task.id, res);
      return;
    }
    // Reflect it in the local cache right away, so we do not wait for the next poll.
    await get().refreshMissions(task.owner.verifiedWorkspaceId);
  },

  detachMissionForPaneGroup: async (paneGroupId) => {
    if (!paneGroupId) return false;
    const task = get().missionByPaneGroup[paneGroupId];
    if (!task) return false;
    // Already detached (closed with a detachedAt marker) = idempotent success, not
    // a failure — a double-click or a race against the cache refresh must NOT raise
    // a "could not detach" toast for a task that is already independent.
    if (task.status === 'closed') return task.detachedAt !== undefined;
    // Only an open, still-dependent child can be detached.
    if (task.status !== 'open') return false;
    const bridge = readMissionRpc();
    if (!bridge?.close) return false;
    let res: unknown;
    try {
      // Same authz anchor as a lifetime close: the daemon gate is owner-OR-CEO and
      // the owner is the PARENT, so pass the task owner (not the child) as the
      // verified workspace. `detach: true` rides the same close RPC — the daemon
      // stamps a workspace-detached marker and archives the channel, and the
      // renderer/main path deliberately touches nothing else (worktree/branch/PTY).
      res = await bridge.close({
        taskId: task.id,
        verifiedWorkspaceId: task.owner.verifiedWorkspaceId,
        detach: true,
      });
    } catch {
      // Daemon not connected / transient failure — the child keeps running; the
      // user can retry. Boot reconcile does NOT auto-detach (detach is an explicit
      // user action), so a failure simply leaves the dependency in place.
      return false;
    }
    if (!isOkObject(unwrapRpc(res))) {
      console.warn('[workTaskSlice] mission detach rejected for task', task.id, res);
      return false;
    }
    // Refresh the parent's mission cache so the row reflects detached immediately.
    await get().refreshMissions(task.owner.verifiedWorkspaceId);
    return true;
  },
});
