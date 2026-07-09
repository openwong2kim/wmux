// ─── 미션(WorkTask) 폴링 훅 (NB2 파동2 사이클 C) ─────────────────────────────
//
// AppLayout에 1회 마운트(useChannelsHydration과 평행). workTaskSlice로 미션 캐시를
// 채운다. 왜 이렇게(순수 pull + 성긴 폴링)인가는 workTaskSlice 헤더 참조:
//   - daemon WorkTaskService는 EventBus에 아무 것도 emit하지 않음 → push 없음.
//   - fan-out 물질화(paneGroupId 등)는 FanOutService.start() 반환 전 동기 커밋 →
//     완료 시점 토폴로지 완결. 남는 드리프트는 상태(open→closed)뿐(저빈도).
// 그래서 트리거는:
//   1. 마운트 + 워크스페이스 목록(id 집합) 변화 → 즉시 refetch(모든 부모 후보).
//   2. 성긴 배경 폴링(MISSION_POLL_INTERVAL_MS) → 상태 드리프트 반영.
//   3. daemon (re)connect → 콜드부트/리스폰 후 재수화.
// fan-out 완료 직후 refetch는 FanOutDialog가 refreshMissions를 직접 호출한다(즉시성).
//
// listMissions는 owner-scoped라, "어떤 워크스페이스가 부모인지"를 미리 알 필요 없이
// 현재 존재하는 모든 워크스페이스 id를 각각 조회하면 된다(fan-out 안 한 워크스페이스는
// 빈 배열을 돌려주므로 무해 — 사이드바 섹션은 빈 캐시에서 아무것도 렌더하지 않는다).

import { useEffect } from 'react';
import { useStore } from '../stores';

/**
 * 미션 상태 드리프트(open→closed)를 잡기 위한 성긴 배경 폴링 주기. 채널 unread의
 * 1Hz events.poll(라이브 메시지 배달용)과 **의도적으로 다르다** — 미션은 사람/에이전트가
 * 이따금 닫는 저빈도 상태라 15초면 충분하고, owner-scoped 맵 조회라 데몬 부하도 미미하다.
 */
export const MISSION_POLL_INTERVAL_MS = 15_000;

/** 현재 워크스페이스 id 전부에 대해 미션을 refetch(각 owner-scoped 조회). */
function refreshAllParents(): void {
  const state = useStore.getState();
  const ids = state.workspaces.map((w) => w.id);
  for (const id of ids) {
    void state.refreshMissions(id);
  }
}

/**
 * AppLayout에 1회 마운트. React state는 소유하지 않고 스토어로 디스패치만 한다.
 * 워크스페이스 id 집합이 바뀔 때마다 재수화하고, 성긴 배경 폴링으로 상태를 갱신한다.
 */
export function useMissionsPolling(): void {
  // id 집합 문자열: 워크스페이스 추가/삭제 시에만 effect를 재실행(이름/메타 변경엔 무반응).
  const workspaceIdsKey = useStore((s) => s.workspaces.map((w) => w.id).join(','));

  useEffect(() => {
    // 마운트 + id 집합 변화 시 즉시 refetch.
    refreshAllParents();

    // 성긴 배경 폴링(상태 드리프트용).
    const timer = setInterval(refreshAllParents, MISSION_POLL_INTERVAL_MS);

    // daemon (re)connect 시 콜드부트/리스폰 후 재수화.
    let disposed = false;
    void window.electronAPI.daemon.whenReady().then(() => {
      if (!disposed) refreshAllParents();
    });
    const offConnected = window.electronAPI.daemon.onConnected(() => {
      if (!disposed) refreshAllParents();
    });

    return () => {
      disposed = true;
      clearInterval(timer);
      offConnected();
    };
  }, [workspaceIdsKey]);
}
