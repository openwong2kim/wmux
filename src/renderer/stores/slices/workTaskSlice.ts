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

/** useRpcBridge가 설치하는 미션 읽기 브리지(단일 메서드 파사드). */
interface MissionRpcBridge {
  list: (params: Record<string, unknown>) => Promise<unknown>;
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

export interface WorkTaskSlice {
  /** 부모 워크스페이스 id → 그 워크스페이스가 owner인 미션(WorkTask) 목록 캐시. */
  missionsByWorkspace: Record<string, WorkTask[]>;
  /** paneGroupId(=자식 워크스페이스 id) → WorkTask 역인덱스(O(1) 조회). */
  missionByPaneGroup: Record<string, WorkTask>;

  /** 한 부모의 미션 목록을 통째로 교체하고 역인덱스를 재구성한다(정본=데몬). */
  setMissions: (parentWorkspaceId: string, tasks: WorkTask[]) => void;
  /** 브리지 경유로 `task.mission.list`를 당겨 setMissions에 투영(best-effort). */
  refreshMissions: (parentWorkspaceId: string) => Promise<void>;
  /** 한 부모의 캐시를 제거(워크스페이스 닫힘 등) 후 역인덱스 재구성. */
  clearMissionsFor: (parentWorkspaceId: string) => void;
  /** paneGroupId로 미션 조회(사이드바/FleetCard 매칭). */
  getMissionForPaneGroup: (paneGroupId: string) => WorkTask | undefined;
}

export const createWorkTaskSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  WorkTaskSlice
> = (set, get) => ({
  missionsByWorkspace: {},
  missionByPaneGroup: {},

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
});
