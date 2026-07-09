// ─── 사이드바 "Missions" 섹션 (NB2 파동2 사이클 C) ───────────────────────────
//
// fan-out(J1)이 만든 미션(WorkTask)을 워크스페이스 리스트 상단의 별도 그룹으로
// 승격한다. 각 미션 = 프롬프트 1개가 펼쳐진 격리 태스크이고, `paneGroupId`가 곧
// 그 태스크 전용 자식 워크스페이스 id다. 행은 title·status(open/closed)와 미션
// 채널로 이어지는 링크를 보여준다.
//
// worktree 배지(⊕, WorkspaceItem)와의 공존: 배지는 "이 워크스페이스가 git worktree"
// 라는 저수준 사실을, 이 섹션은 "이 워크스페이스가 fan-out 태스크"라는 상위 개념을
// 얹는다(worktree ⊂ task는 아님 — broadcast 모드는 격리 없음). 둘은 서로 다른 축이라
// 같은 자식 워크스페이스가 사이드바 리스트(배지 있음)와 이 섹션(미션 행)에 모두 나올
// 수 있고, 이는 의도된 이중 표현이다.
//
// 빈 상태: 미션이 하나도 없으면(대부분의 일반 워크스페이스) 이 컴포넌트는 null을
// 반환해 **공간을 전혀 차지하지 않는다**(헤더조차 렌더하지 않음).

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import type { WorkTask } from '../../../shared/workTask';

/**
 * 모든 부모 캐시를 평탄화·정렬한 미션 목록(순수 함수 — 테스트 가능). open을 먼저,
 * 그 안에서 최신(createdAt desc) 순으로 정렬한다. 태스크는 부모 하나에만 속하므로
 * 중복은 없다.
 */
export function flattenMissions(byWorkspace: Record<string, WorkTask[]>): WorkTask[] {
  const all: WorkTask[] = [];
  for (const tasks of Object.values(byWorkspace)) all.push(...tasks);
  return all.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function useFlatMissions(): WorkTask[] {
  const byWorkspace = useStore(useShallow((s) => s.missionsByWorkspace));
  return useMemo(() => flattenMissions(byWorkspace), [byWorkspace]);
}

function MissionRow({ task }: { task: WorkTask }): React.ReactElement {
  // 자식 워크스페이스 존재 여부(존재할 때만 행 클릭으로 점프 가능).
  const childExists = useStore((s) =>
    task.paneGroupId ? s.workspaces.some((w) => w.id === task.paneGroupId) : false,
  );
  const isOpen = task.status === 'open';
  const statusColor = isOpen ? 'var(--accent-green)' : 'var(--text-muted)';

  const jumpToChild = (): void => {
    if (task.paneGroupId && childExists) {
      useStore.getState().setActiveWorkspace(task.paneGroupId);
    }
  };
  const openMissionChannel = (): void => {
    // 기존 채널 열기 경로 재사용(setActiveChannel이 dock을 열고 채널을 선택) —
    // 새 라우팅을 만들지 않는다.
    useStore.getState().setActiveChannel(task.missionChannelId);
  };

  return (
    <div
      className={`group flex items-center gap-2 mx-2 px-3 py-1 rounded-md select-none ${
        task.paneGroupId && childExists
          ? 'cursor-pointer hover:bg-[rgba(var(--bg-surface-rgb),0.5)]'
          : ''
      }`}
      onClick={jumpToChild}
      data-mission-row
      data-task-id={task.id}
      data-task-status={task.status}
    >
      {/* status dot: open=green, closed=muted */}
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: statusColor }}
        title={isOpen ? 'open' : 'closed'}
      />
      <span
        className={`flex-1 min-w-0 truncate text-caption font-mono ${
          isOpen ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)] line-through'
        }`}
        title={task.title}
      >
        {task.title}
      </span>
      {/* 미션 채널 링크 — 기존 ChannelDock으로 해당 채널을 연다. */}
      <button
        type="button"
        className="flex-shrink-0 text-[10px] font-mono text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          openMissionChannel();
        }}
        title={`Open mission channel`}
        aria-label={`Open mission channel for ${task.title}`}
        data-mission-channel-link
      >
        #
      </button>
    </div>
  );
}

function MissionsSection(): React.ReactElement | null {
  const missions = useFlatMissions();
  // 빈 상태: 미션이 없으면 아무 것도 렌더하지 않는다(공간 0).
  if (missions.length === 0) return null;

  return (
    <div className="mb-1" data-missions-section>
      <div className="px-4 pt-1 pb-1 text-[9px] font-mono font-semibold tracking-widest text-[var(--text-muted)] uppercase">
        Missions
      </div>
      <div className="space-y-0.5">
        {missions.map((task) => (
          <MissionRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

export default memo(MissionsSection);
