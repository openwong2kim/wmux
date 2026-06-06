import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Pane, type PaneBranch, type Surface, type Workspace } from '../../../../shared/types';

type TestState = WorkspaceSlice & { multiviewIds: string[] };

function createTestStore(initialWorkspaces: Workspace[], activeId: string) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      workspaces: initialWorkspaces,
      activeWorkspaceId: activeId,
      multiviewIds: [],
    })),
  );
}

function allSurfaces(pane: Pane): Surface[] {
  return pane.type === 'leaf' ? pane.surfaces : pane.children.flatMap(allSurfaces);
}

describe('WorkspaceSlice.duplicateWorkspace', () => {
  it('inserts the clone right after the source and activates it', () => {
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const store = createTestStore([a, b], b.id);

    store.getState().duplicateWorkspace(a.id);

    const ws = store.getState().workspaces;
    expect(ws).toHaveLength(3);
    expect(ws[0].id).toBe(a.id);
    expect(ws[1].name).toBe('A (copy)'); // inserted after source
    expect(ws[2].id).toBe(b.id);
    expect(store.getState().activeWorkspaceId).toBe(ws[1].id);
  });

  it('names successive copies A (copy), A (copy 2), A (copy 3)', () => {
    const a = createWorkspace('A');
    const store = createTestStore([a], a.id);

    store.getState().duplicateWorkspace(a.id);
    store.getState().duplicateWorkspace(a.id);
    store.getState().duplicateWorkspace(a.id);

    const names = store.getState().workspaces.map((w) => w.name);
    expect(names).toContain('A (copy)');
    expect(names).toContain('A (copy 2)');
    expect(names).toContain('A (copy 3)');
  });

  it('does not stack the copy suffix when duplicating a copy', () => {
    const a = createWorkspace('A (copy)');
    const store = createTestStore([a], a.id);

    store.getState().duplicateWorkspace(a.id);

    const names = store.getState().workspaces.map((w) => w.name);
    // root "A" is re-derived, so "A (copy)" copies to "A (copy 2)", not "A (copy) (copy)".
    expect(names).toContain('A (copy 2)');
    expect(names).not.toContain('A (copy) (copy)');
  });

  it('clones the layout with fresh ids and cleared ptyIds', () => {
    const a = createWorkspace('A');
    // Build a 2-leaf split with live ptyIds.
    const branch: PaneBranch = {
      id: 'branch-1',
      type: 'branch',
      direction: 'vertical',
      sizes: [0.5, 0.5],
      children: [
        { id: 'p1', type: 'leaf', activeSurfaceId: 's1', surfaces: [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'sh', cwd: '/a' }] },
        { id: 'p2', type: 'leaf', activeSurfaceId: 's2', surfaces: [{ id: 's2', ptyId: 'pty-2', title: 't', shell: 'sh', cwd: '/b' }] },
      ],
    };
    a.rootPane = branch;
    a.activePaneId = 'p2';
    const store = createTestStore([a], a.id);

    store.getState().duplicateWorkspace(a.id);
    const clone = store.getState().workspaces[1];

    expect(clone.rootPane.id).not.toBe('branch-1');
    const surfs = allSurfaces(clone.rootPane);
    expect(surfs).toHaveLength(2);
    expect(surfs.every((s) => s.ptyId === '')).toBe(true);
    expect(surfs.map((s) => s.cwd)).toEqual(['/a', '/b']); // geometry/content preserved
    // active pane preserved by position (index 1).
    const cloneLeafIds = clone.rootPane.type === 'branch' ? clone.rootPane.children.map((c) => c.id) : [];
    expect(clone.activePaneId).toBe(cloneLeafIds[1]);

    // Source untouched.
    expect(allSurfaces(a.rootPane).map((s) => s.ptyId)).toEqual(['pty-1', 'pty-2']);
  });

  it('copies the profile (re-normalized) and drops secret-named env keys', () => {
    const a = createWorkspace('A');
    a.profile = { env: { CLAUDE_CONFIG_DIR: '/cfg', MY_API_KEY: 'sk-secret' }, defaultPaneCommand: 'claude' };
    const store = createTestStore([a], a.id);

    store.getState().duplicateWorkspace(a.id);
    const clone = store.getState().workspaces[1];

    expect(clone.profile?.defaultPaneCommand).toBe('claude');
    expect(clone.profile?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/cfg' });
    // Secret-named key dropped by the save-boundary policy (dropSecretKeys).
    expect(clone.profile?.env?.MY_API_KEY).toBeUndefined();
    // Cloned env is not the same object reference as the source.
    expect(clone.profile?.env).not.toBe(a.profile?.env);
  });

  it('leaves a profile-less workspace without a profile', () => {
    const a = createWorkspace('A');
    const store = createTestStore([a], a.id);
    store.getState().duplicateWorkspace(a.id);
    expect(store.getState().workspaces[1].profile).toBeUndefined();
  });

  it('is a no-op for an unknown id', () => {
    const a = createWorkspace('A');
    const store = createTestStore([a], a.id);
    store.getState().duplicateWorkspace('nope');
    expect(store.getState().workspaces).toHaveLength(1);
  });
});
