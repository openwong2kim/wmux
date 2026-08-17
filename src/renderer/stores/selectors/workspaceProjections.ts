/**
 * A1 (NB2 파동 0) — workspaces 통트리 구독을 대체하는 최소 파생 셀렉터.
 *
 * `s.workspaces`를 통째로 구독하면 에이전트 출력이 metadata/surface 필드를
 * 갱신할 때마다 immer가 workspaces 참조를 새로 만들고 구독자 전부가 리렌더된다.
 * 여기의 투영들은 컴포넌트가 실제로 쓰는 필드만 뽑아, `useShallow`와 함께 쓰면
 * 그 필드가 바뀔 때만 리렌더되게 한다.
 *
 * 사용법: `useStore(selectWorkspaceIdName)` (useShallow로 감싸도 무해).
 *
 * 리뷰 반영(파동 0 패널): 초판은 매 호출 새 원소 객체를 만들어 useShallow의
 * 원소 Object.is 비교가 항상 실패했다(리렌더 감소 무력화). 지금은 배열 투영이
 * 원소·배열 **참조 캐시**를 갖는다 — 투영 필드가 같으면 이전 원소 참조를,
 * 전 원소가 같으면 이전 배열 참조를 재사용하므로 zustand의 기본 Object.is
 * 비교만으로 "관심 필드가 실제로 바뀔 때만" 리렌더가 성립한다.
 */

import type { StoreState } from '../index';
import type { AgentStatus, Workspace } from '../../../shared/types';
import type { WorkspaceColorId } from '../../../shared/workspaceColors';

/**
 * 배열 투영의 참조 캐시 팩토리. `project`가 만든 원소를 이전 호출의 같은 id
 * 원소와 `equal`로 비교해 같으면 이전 참조를 재사용하고, 전 원소가 재사용되면
 * 배열 참조 자체도 재사용한다. 통트리 참조가 그대로면 즉시 이전 배열 반환.
 * (모듈 레벨 캐시 — 스토어가 여러 개여도 fresh 비교 기반이라 안전하다.)
 */
function makeCachedListProjection<E extends { id: string }>(
  project: (w: Workspace) => E,
  equal: (a: E, b: E) => boolean,
): (s: StoreState) => E[] {
  let prevWorkspaces: StoreState['workspaces'] | null = null;
  let prevById = new Map<string, E>();
  let prevArr: E[] = [];
  return (s) => {
    if (s.workspaces === prevWorkspaces) return prevArr;
    const nextById = new Map<string, E>();
    let changed = s.workspaces.length !== prevArr.length;
    const arr = s.workspaces.map((w, i) => {
      const fresh = project(w);
      const prev = prevById.get(w.id);
      const elem = prev !== undefined && equal(prev, fresh) ? prev : fresh;
      if (elem !== prevArr[i]) changed = true;
      nextById.set(w.id, elem);
      return elem;
    });
    prevWorkspaces = s.workspaces;
    prevById = nextById;
    if (changed) prevArr = arr;
    return prevArr;
  };
}

/** {id, name} 요약 — 목록 렌더링(팔레트·미니 사이드바·이름 해석)용. */
export interface WorkspaceIdName {
  id: string;
  name: string;
}

export const selectWorkspaceIdName = makeCachedListProjection<WorkspaceIdName>(
  (w) => ({ id: w.id, name: w.name }),
  (a, b) => a.name === b.name,
);

/** id 순서 시그니처 — "목록 구조(추가/삭제/재정렬)"만 관심 있는 구독자용.
 *  개별 항목 내용 변경에는 반응하지 않는다(WorkspaceItem이 자기 내용을 구독). */
export function selectWorkspaceIds(s: StoreState): string[] {
  return s.workspaces.map((w) => w.id);
}

/** 48px 레일(MiniSidebar) 요약 — id/name + 에이전트 상태 도트에 필요한 필드만.
 *  cwd/git/port 변경에는 반응하지 않는다. */
export interface WorkspaceRailSummary {
  id: string;
  name: string;
  agentStatus: AgentStatus | undefined;
  agentName: string | undefined;
  /** Optional color tag — the rail is where a 2-letter label needs it most. */
  color: WorkspaceColorId | undefined;
}

export const selectWorkspaceRailSummary = makeCachedListProjection<WorkspaceRailSummary>(
  (w) => ({
    id: w.id,
    name: w.name,
    agentStatus: w.metadata?.agentStatus,
    agentName: w.metadata?.agentName,
    color: w.color,
  }),
  (a, b) => a.name === b.name && a.agentStatus === b.agentStatus && a.agentName === b.agentName
    && a.color === b.color,
);

/** 활성 워크스페이스의 표시 요약(이름 + git 브랜치) — StatusBar 좌측용.
 *  활성 ws의 이 두 필드가 바뀔 때만 바뀐다(다른 ws의 metadata 변경 무시).
 *  활성 ws가 아직 없으면(초기) name=''·branch=undefined. */
export interface ActiveWorkspaceSummary {
  name: string;
  branch: string | undefined;
}

export function selectActiveWorkspaceSummary(s: StoreState): ActiveWorkspaceSummary {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  return { name: ws?.name ?? '', branch: ws?.metadata?.gitBranch };
}

/**
 * 활성 워크스페이스 OBJECT 자체 — rootPane/metadata를 깊이 읽어야 하는 활성-ws
 * 전용 구독자(AgentToolbar·FileExplorerPopover·FileTreePanel)용.
 *
 * 새 객체를 만들지 않고 immer가 관리하는 ws 참조를 그대로 돌려주므로, 활성 ws가
 * 실제로 바뀔 때(전환 또는 그 ws의 트리 변경)만 참조가 달라진다 — 배경 ws의
 * churn에는 반응하지 않는다. useShallow 불필요(참조 동일성으로 충분·안전).
 */
export function selectActiveWorkspace(s: StoreState): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
}

/**
 * id로 특정 워크스페이스 OBJECT를 구독하는 셀렉터 팩토리 — 리스트 자식이
 * "자기 자신의 ws"만 구독하게 한다(WorkspaceItem). 부모(Sidebar)는 목록 구조만
 * 구독하고, 각 자식은 이 셀렉터로 자기 ws 변경에만 리렌더된다.
 *
 * immer가 관리하는 ws 참조를 그대로 돌려주므로 useShallow 불필요(참조 동일성).
 */
export function selectWorkspaceById(id: string) {
  return (s: StoreState): Workspace | undefined => s.workspaces.find((w) => w.id === id);
}

/** {id, name, notificationsMuted} — 알림 뮤트 토글 목록(Settings)용. */
export interface WorkspaceMuteRow {
  id: string;
  name: string;
  notificationsMuted: boolean;
}

export const selectWorkspaceMuteRows = makeCachedListProjection<WorkspaceMuteRow>(
  (w) => ({
    id: w.id,
    name: w.name,
    notificationsMuted: w.metadata?.notificationsMuted ?? false,
  }),
  (a, b) => a.name === b.name && a.notificationsMuted === b.notificationsMuted,
);
