// @vitest-environment jsdom
//
// 리렌더 회귀 테스트 (NB2 파동 0 검증 게이트).
//
// 실제 스토어 + 실제 컴포넌트를 jsdom에 마운트하고 React <Profiler>의 onRender
// 콜백으로 "커밋 컴포넌트 수"를 계측한다(스펙의 Profiler 계수). 검증:
//   (a) 무관 워크스페이스의 타이틀 변경 시 StatusBar·다른 WorkspaceItem이
//       리렌더되지 않는다(A1 셀렉터 다이어트 + A5 시계 분리 효과).
//   (b) memo 컴포넌트(WorkspaceItem)가 동일 prop에서 리렌더 0.
//   (c) 활성 ws의 자기 변경은 해당 WorkspaceItem만 리렌더한다(self-subscribe).
//
// @testing-library는 저장소 의존성 금지라 쓰지 않는다 — PaneContainer.zoom
// 테스트와 동일하게 createRoot + act + Profiler로 직접 구동한다.
import React, { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// StatusClock의 메모리 폴 + WorkspaceItem의 shell/platform 접근에 필요한 최소
// electronAPI 목. getMemoryUsage는 값을 안 주게 해서(0) setState 리렌더 유발을
// 피한다(계측 잡음 제거).
(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
Object.defineProperty(globalThis, 'electronAPI', { value: undefined, writable: true, configurable: true });
(window as unknown as { electronAPI: unknown }).electronAPI = {
  system: { getMemoryUsage: () => Promise.resolve(0) },
  platform: 'darwin',
  shell: { openExternal: () => undefined },
  // StatusBar → PluginStatusBarWidgets → usePlugins.list()가 마운트 시 호출된다.
  // 빈 목록을 즉시 돌려줘 unhandled rejection을 없앤다(계측 잡음 제거).
  plugins: { list: () => Promise.resolve({ plugins: [], failures: [] }) },
};

import { useStore } from '../../stores';
import StatusBar from '../StatusBar/StatusBar';
import WorkspaceItem from '../Sidebar/WorkspaceItem';
import type { SessionData, Workspace } from '../../../shared/types';

function makeWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 'term', shell: 'bash', cwd: '/x' }],
      activeSurfaceId: `${id}-surf`,
    },
    activePaneId: `${id}-pane`,
  } as Workspace;
}

let container: HTMLDivElement;
let root: Root;

/** Profiler 커밋 카운터: 각 마운트 subtree의 onRender 호출 횟수를 센다. */
const commits: Record<string, number> = {};
function reset(id: string) { commits[id] = 0; }
function onRender(id: string) { commits[id] = (commits[id] ?? 0) + 1; }

beforeEach(async () => {
  // 두 워크스페이스를 시드(ws-1 활성). loadSession으로 스토어를 알려진 상태로.
  const data: SessionData = {
    workspaces: [makeWorkspace('ws-1', 'Alpha'), makeWorkspace('ws-2', 'Bravo')],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => { useStore.getState().loadSession(data); });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  for (const k of Object.keys(commits)) delete commits[k];
  reset('statusbar'); reset('item-1'); reset('item-2');

  const noop = () => undefined;
  act(() => {
    root.render(
      React.createElement(React.Fragment, null,
        React.createElement(Profiler, { id: 'statusbar', onRender: () => onRender('statusbar') },
          React.createElement(StatusBar),
        ),
        React.createElement(Profiler, { id: 'item-1', onRender: () => onRender('item-1') },
          React.createElement(WorkspaceItem, {
            workspaceId: 'ws-1', isActive: true, isMultiview: false, index: 0,
            onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
            onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
          }),
        ),
        React.createElement(Profiler, { id: 'item-2', onRender: () => onRender('item-2') },
          React.createElement(WorkspaceItem, {
            workspaceId: 'ws-2', isActive: false, isMultiview: false, index: 1,
            onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
            onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
          }),
        ),
      ),
    );
  });

  // 비동기 부수효과(usePlugins.list 등)가 마운트 직후 settle하며 유발하는
  // 리렌더를 여기서 모두 흘려보낸다 — 이후 각 테스트의 reset 기준선이 깨끗해진다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('re-render regression (NB2 파동 0)', () => {
  it('무관 ws(ws-2)의 타이틀 변경은 StatusBar와 ws-1 항목을 리렌더하지 않는다', () => {
    // 마운트 이후 카운터 리셋 — 이후 커밋만 계측.
    reset('statusbar'); reset('item-1'); reset('item-2');

    // ws-2의 surface 타이틀만 바꾼다(무관 워크스페이스의 메타 churn 시뮬레이션).
    act(() => { useStore.getState().updateSurfaceTitleByPty('ws-2-pty', 'changed-title'); });

    // A1/A5: StatusBar(활성 ws 요약+unreadCount만 구독)와 ws-1 항목(자기 ws만
    // 구독)은 ws-2 변경에 리렌더되면 안 된다.
    expect(commits['statusbar']).toBe(0);
    expect(commits['item-1']).toBe(0);
    // self-subscribe한 ws-2 항목만 리렌더된다(제목이 실제로 바뀌었으므로).
    expect(commits['item-2']).toBeGreaterThanOrEqual(1);
  });

  it('무관 ws(ws-2)의 cwd/git 메타 변경도 StatusBar·ws-1을 리렌더하지 않는다', () => {
    reset('statusbar'); reset('item-1'); reset('item-2');

    act(() => { useStore.getState().updateWorkspaceMetadata('ws-2', { cwd: '/new/path', gitBranch: 'feature' }); });

    expect(commits['statusbar']).toBe(0);
    expect(commits['item-1']).toBe(0);
    expect(commits['item-2']).toBeGreaterThanOrEqual(1);
  });

  it('활성 ws(ws-1)의 자기 변경은 그 항목만 리렌더한다(다른 항목 0)', () => {
    reset('statusbar'); reset('item-1'); reset('item-2');

    act(() => { useStore.getState().renameWorkspace('ws-1', 'Alpha-renamed'); });

    // ws-1 항목은 자기 이름이 바뀌었으니 리렌더. ws-2 항목은 무관 → 0.
    expect(commits['item-1']).toBeGreaterThanOrEqual(1);
    expect(commits['item-2']).toBe(0);
    // StatusBar는 활성 ws 이름을 표시하므로 이름 변경 시 리렌더된다(정상).
    expect(commits['statusbar']).toBeGreaterThanOrEqual(1);
  });

  it('메모: 무관 슬라이스(notifications) 변경은 세 컴포넌트 모두 리렌더하지 않는다', () => {
    // StatusBar는 unreadCount(notifications 파생)를 구독하므로, 읽음 상태를 안
    // 바꾸는 무관 슬라이스 갱신이 없도록 여기서는 순수 무관 필드(prefixError=null→
    // 동일값)로는 검증이 애매하다. 대신 아무 것도 안 바꾸는 set으로 참조 안정성을
    // 확인한다: 동일 값 set은 immer가 새 참조를 만들 수 있으나 셀렉터가 값 기준
    // 비교(number/useShallow)라 리렌더가 없어야 한다.
    reset('statusbar'); reset('item-1'); reset('item-2');
    act(() => { useStore.setState({ prefixError: null }); });
    expect(commits['statusbar']).toBe(0);
    expect(commits['item-1']).toBe(0);
    expect(commits['item-2']).toBe(0);
  });
});
