import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// Minimal store satisfying WorkspaceSlice + the pieces of UISlice the
// setActiveWorkspace logic touches (multiviewIds). We don't pull in the
// real UISlice to keep the test isolated to setActiveWorkspace behavior.
type TestState = WorkspaceSlice & {
  multiviewIds: string[];
};

function createTestStore(initialWorkspaces: Workspace[], activeId: string, multiviewIds: string[] = []) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // Override the slice's defaults AFTER spreading. createWorkspaceSlice
      // initializes workspaces with a fresh "Workspace 1" — we replace those
      // with our test fixtures here.
      workspaces: initialWorkspaces,
      activeWorkspaceId: activeId,
      multiviewIds,
    }))
  );
}

describe('WorkspaceSlice.setActiveWorkspace', () => {
  let wsA: Workspace;
  let wsB: Workspace;
  let wsC: Workspace;

  beforeEach(() => {
    wsA = createWorkspace('A');
    wsB = createWorkspace('B');
    wsC = createWorkspace('C');
  });

  it('switches active workspace when target exists', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    store.getState().setActiveWorkspace(wsB.id);
    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
  });

  it('ignores unknown workspace ids', () => {
    const store = createTestStore([wsA], wsA.id);
    store.getState().setActiveWorkspace('does-not-exist');
    expect(store.getState().activeWorkspaceId).toBe(wsA.id);
  });

  // 멀티뷰 그룹은 명시적으로 해제하기 전까지 유지된다. 사용자가 그룹 외부
  // 워크스페이스를 단순 클릭하면 그 워크스페이스의 단일 뷰로 전환되지만,
  // 저장된 그룹은 그대로 보존돼서 그룹 멤버를 다시 누르면 그리드가 복원된다.
  // (그리드 표시 조건은 AppLayout에서 activeWorkspaceId가 multiviewIds에
  // 포함된 경우로 게이트됨 — 첫 회귀 "다른 탭 눌러도 화면 안 바뀜"도 같이 해결.)
  it('preserves the saved multiview group when switching outside of it', () => {
    const store = createTestStore(
      [wsA, wsB, wsC],
      wsA.id,
      [wsA.id, wsB.id], // multiview = A + B
    );
    store.getState().setActiveWorkspace(wsC.id); // C is NOT in multiview

    expect(store.getState().activeWorkspaceId).toBe(wsC.id);
    expect(store.getState().multiviewIds).toEqual([wsA.id, wsB.id]);
  });

  it('keeps multiview intact when switching to a workspace already in it', () => {
    const store = createTestStore(
      [wsA, wsB, wsC],
      wsA.id,
      [wsA.id, wsB.id],
    );
    store.getState().setActiveWorkspace(wsB.id); // B IS in multiview

    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
    expect(store.getState().multiviewIds).toEqual([wsA.id, wsB.id]);
  });

  it('does not touch multiview when fewer than 2 ids are present', () => {
    const store = createTestStore(
      [wsA, wsB],
      wsA.id,
      [], // multiview inactive
    );
    store.getState().setActiveWorkspace(wsB.id);

    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
    expect(store.getState().multiviewIds).toEqual([]);
  });

  it('ignores unknown ids without disturbing multiview', () => {
    const store = createTestStore(
      [wsA, wsB],
      wsA.id,
      [wsA.id, wsB.id],
    );
    store.getState().setActiveWorkspace('ghost');
    expect(store.getState().activeWorkspaceId).toBe(wsA.id);
    expect(store.getState().multiviewIds).toEqual([wsA.id, wsB.id]);
  });
});
