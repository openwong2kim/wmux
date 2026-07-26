import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createA2aSlice } from '../a2aSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import {
  beginSessionLocationProjection,
  getRememberedSessionLocation,
  rememberSessionLocation,
  resetSessionLocationProjections,
} from '../../sessionLocationProjection';

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

  // Multiview groups persist until explicitly cleared. Clicking a workspace outside the group
  // switches to that workspace's single view, but the saved group remains so clicking a group
  // member again restores the grid.
  // (Grid display gated in AppLayout when activeWorkspaceId is in multiviewIds —
  // also fixes first regression "clicking another tab doesn't change view".)
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
    // Completion-evidence gate (PR-B) active: completed requires structured evidence — attach minimal client evidence.
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

  it('releases every location projection owned by the removed workspace', () => {
    resetSessionLocationProjections();
    const wsA = createWorkspace('A');
    const wsB = createWorkspace('B');
    if (wsB.rootPane.type !== 'leaf') throw new Error('expected leaf');
    wsB.rootPane.surfaces.push({
      id: 'surface-b',
      ptyId: 'pty-b',
      title: 'B',
      shell: 'pwsh.exe',
      cwd: 'C:/live',
      surfaceType: 'terminal',
    });
    beginSessionLocationProjection('pty-b');
    rememberSessionLocation('pty-b', {
      generation: 1,
      revision: 1,
      location: { domain: 'host', cwd: 'C:/live', shell: 'pwsh.exe' },
    });
    const store = createComboStore([wsA, wsB], wsA.id);

    store.getState().removeWorkspace(wsB.id);

    expect(getRememberedSessionLocation('pty-b')).toBeUndefined();
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
