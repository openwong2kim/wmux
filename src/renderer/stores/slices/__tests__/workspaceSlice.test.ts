import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createA2aSlice } from '../a2aSlice';
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

describe('removeWorkspace — A8: fail tasks delegated to a closed workspace', () => {
  // Combined store (workspace + a2a slices) so removeWorkspace can see a2aTasks.
  function createComboStore(workspaces: Workspace[], activeId: string) {
    return create<WorkspaceSlice & ReturnType<typeof createA2aSlice>>()(
      immer((...args) => ({
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createWorkspaceSlice(...args),
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createA2aSlice(...args),
        workspaces,
        activeWorkspaceId: activeId,
      })),
    );
  }

  it('fails an in-flight task delegated TO the closed workspace', () => {
    const wsA = createWorkspace('A');
    const wsB = createWorkspace('B');
    const store = createComboStore([wsA, wsB], wsA.id);
    const id = store.getState().createA2aTask({
      title: 't',
      from: { workspaceId: wsA.id, name: 'A' },
      to: { workspaceId: wsB.id, name: 'B' },
      history: [],
      artifacts: [],
    });
    store.getState().updateTaskStatus(id, 'working', wsB.id);
    expect(store.getState().a2aTasks[id].status.state).toBe('working');
    store.getState().removeWorkspace(wsB.id); // delegate workspace closes
    expect(store.getState().a2aTasks[id].status.state).toBe('failed');
    expect(store.getState().a2aTasks[id].status.message?.parts[0]).toMatchObject({ kind: 'text' });
  });

  it('leaves terminal tasks and tasks delegated elsewhere untouched', () => {
    const wsA = createWorkspace('A');
    const wsB = createWorkspace('B');
    const store = createComboStore([wsA, wsB], wsA.id);
    const done = store.getState().createA2aTask({
      title: 'done',
      from: { workspaceId: wsA.id, name: 'A' },
      to: { workspaceId: wsB.id, name: 'B' },
      history: [],
      artifacts: [],
    });
    store.getState().updateTaskStatus(done, 'working', wsB.id);
    // 완료증거 게이트(PR-B) 활성 후 completed는 구조화 증거 필수 — 최소 컴플라이언트 증거 첨부.
    store.getState().updateTaskStatus(done, 'completed', wsB.id, undefined, undefined, {
      summary: 'done',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }],
    });
    const toA = store.getState().createA2aTask({
      title: 'toA',
      from: { workspaceId: wsB.id, name: 'B' },
      to: { workspaceId: wsA.id, name: 'A' },
      history: [],
      artifacts: [],
    });
    store.getState().removeWorkspace(wsB.id);
    expect(store.getState().a2aTasks[done].status.state).toBe('completed'); // terminal untouched
    expect(store.getState().a2aTasks[toA].status.state).toBe('submitted'); // to A, untouched
  });
});

// PERF INVARIANT (2026-07-13): the WorkspaceSlot React.memo in AppLayout only
// skips re-rendering an unchanged workspace if updateWorkspaceMetadata keeps
// the OTHER workspaces referentially identical (immer structural sharing). If a
// refactor rebuilds the workspaces array or clones every entry, the memo
// silently stops working and the "5 workspaces = laggy" bug returns. Lock it.
describe('updateWorkspaceMetadata — referential stability (WorkspaceSlot memo dep)', () => {
  it('replaces ONLY the changed workspace object; siblings keep their reference', () => {
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const c = createWorkspace('C');
    const store = createTestStore([a, b, c], a.id);

    const before = store.getState().workspaces;
    const [beforeA, beforeB, beforeC] = before;

    store.getState().updateWorkspaceMetadata(b.id, { agentName: 'changed' });

    const after = store.getState().workspaces;
    expect(after).not.toBe(before);             // the array itself is new (triggers AppLayout)
    expect(after[1]).not.toBe(beforeB);         // the CHANGED workspace is a new object
    expect(after[1].metadata?.agentName).toBe('changed');
    // The UNCHANGED siblings keep their exact reference → memo bails on them.
    expect(after[0]).toBe(beforeA);
    expect(after[2]).toBe(beforeC);
    // And their pane trees are untouched references too (PaneContainer prop).
    expect(after[0].rootPane).toBe(beforeA.rootPane);
    expect(after[2].rootPane).toBe(beforeC.rootPane);
  });

  it('keeps the changed workspace pane tree stable when only metadata changes', () => {
    const a = createWorkspace('A');
    const store = createTestStore([a], a.id);
    const beforeRoot = store.getState().workspaces[0].rootPane;
    store.getState().updateWorkspaceMetadata(a.id, { agentName: 'x' });
    // metadata change must NOT churn the rootPane reference (it's a separate
    // prop; churning it would re-render the terminal subtree needlessly).
    expect(store.getState().workspaces[0].rootPane).toBe(beforeRoot);
  });
});

// #751 — removeWorkspace spliced the workspace but left its id in multiviewIds.
// The grid gate counts multiviewIds while the tiles are filtered against live
// workspaces, so one live member plus one stale id rendered a one-tile "grid"
// with multiview chrome, escapable only via Ctrl+Shift+G.
describe('removeWorkspace — multiview membership is pruned', () => {
  function createMvStore(workspaces: Workspace[], activeId: string, multiviewIds: string[]) {
    return create<WorkspaceSlice & { multiviewIds: string[] }>()(
      immer((...args) => ({
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createWorkspaceSlice(...args),
        workspaces,
        activeWorkspaceId: activeId,
        multiviewIds,
      })),
    );
  }

  it('drops the closed workspace from the group', () => {
    const [a, b, c] = [createWorkspace('A'), createWorkspace('B'), createWorkspace('C')];
    const store = createMvStore([a, b, c], a.id, [a.id, b.id, c.id]);
    store.getState().removeWorkspace(b.id);
    expect(store.getState().multiviewIds).toEqual([a.id, c.id]);
  });

  it('clears the group when closing would leave a single member', () => {
    // Otherwise the gate (multiviewIds.length >= 2) still passes while only one
    // tile can be rendered — the one-tile grid from #751.
    const [a, b, c] = [createWorkspace('A'), createWorkspace('B'), createWorkspace('C')];
    const store = createMvStore([a, b, c], a.id, [a.id, b.id]);
    store.getState().removeWorkspace(b.id);
    expect(store.getState().multiviewIds).toEqual([]);
  });

  it('promotes a surviving GRID MEMBER when the active member is closed', () => {
    // The third entry point into #752: promoting by array position can land on
    // a workspace outside the group, and the gate needs the active workspace to
    // be a member — so closing the active tile from the sidebar would take every
    // remaining tile with it.
    // workspaces [A,B,C,D], group [A,B,D], active B. Positional promotion would
    // pick C, which is not a member.
    const [a, b, c, d] = [createWorkspace('A'), createWorkspace('B'), createWorkspace('C'), createWorkspace('D')];
    const store = createMvStore([a, b, c, d], b.id, [a.id, b.id, d.id]);
    store.getState().removeWorkspace(b.id);
    expect(store.getState().multiviewIds).toEqual([a.id, d.id]);
    expect(store.getState().multiviewIds).toContain(store.getState().activeWorkspaceId);
    expect(store.getState().activeWorkspaceId).toBe(d.id); // the grid neighbour
  });

  it('falls back to positional promotion when the group does not survive', () => {
    // Group of two: removing one disbands it, so there is no member to promote
    // and the ordinary neighbour-by-position rule applies.
    const [a, b, c] = [createWorkspace('A'), createWorkspace('B'), createWorkspace('C')];
    const store = createMvStore([a, b, c], a.id, [a.id, b.id]);
    store.getState().removeWorkspace(a.id);
    expect(store.getState().multiviewIds).toEqual([]);
    expect(store.getState().activeWorkspaceId).toBe(b.id);
  });

  it('leaves the group alone when a non-member is closed', () => {
    const [a, b, c] = [createWorkspace('A'), createWorkspace('B'), createWorkspace('C')];
    const store = createMvStore([a, b, c], a.id, [a.id, b.id]);
    store.getState().removeWorkspace(c.id);
    expect(store.getState().multiviewIds).toEqual([a.id, b.id]);
  });
});
