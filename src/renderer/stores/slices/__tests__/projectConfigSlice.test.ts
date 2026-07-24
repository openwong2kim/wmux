import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createProjectConfigSlice, type ProjectConfigSlice } from '../projectConfigSlice';
import { createWorkspace, createSurface, type Workspace, type Pane } from '../../../../shared/types';
import type { ProjectConfigState } from '../../../../shared/wmuxProjectConfig';

type TestState = ProjectConfigSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  // uiSlice field that applyProjectLayout resets for zoom coherence.
  zoomedPaneId: string | null;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      zoomedPaneId: null,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createProjectConfigSlice(...args),
    }))
  );
}

function trustedState(overrides: Partial<ProjectConfigState> = {}): ProjectConfigState {
  return {
    found: true,
    root: 'd:\\proj',
    configPath: 'd:\\proj\\wmux.json',
    contentHash: 'a'.repeat(64),
    trust: 'trusted',
    config: {
      version: 1,
      layout: {
        type: 'branch',
        direction: 'horizontal',
        sizes: [60, 40],
        children: [
          { type: 'leaf', command: 'claude' },
          {
            type: 'branch',
            direction: 'vertical',
            children: [
              { type: 'leaf', command: 'npm run dev', cwd: 'packages/web' },
              { type: 'leaf', url: 'http://localhost:3000' },
            ],
          },
        ],
      },
    },
    ...overrides,
  };
}

function collectLeaves(pane: Pane): Extract<Pane, { type: 'leaf' }>[] {
  if (pane.type === 'leaf') return [pane];
  return pane.children.flatMap(collectLeaves);
}

describe('projectConfigSlice', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;

  beforeEach(() => {
    store = createTestStore();
    wsId = store.getState().activeWorkspaceId;
  });

  describe('applyProjectLayout', () => {
    it('replaces the root pane with the layout tree and seeds every leaf', () => {
      store.getState().setProjectConfig(wsId, trustedState());
      const result = store.getState().applyProjectLayout(wsId);
      expect(result.ok).toBe(true);

      const ws = store.getState().workspaces[0];
      expect(ws.rootPane.type).toBe('branch');
      const leaves = collectLeaves(ws.rootPane);
      expect(leaves).toHaveLength(3);
      expect(leaves.every((l) => l.surfaces.length === 0)).toBe(true);
      expect(ws.activePaneId).toBe(leaves[0].id);

      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]).toEqual({ command: 'claude', cwd: 'd:\\proj' });
      expect(seeds[leaves[1].id]).toEqual({ command: 'npm run dev', cwd: 'd:\\proj\\packages\\web' });
      expect(seeds[leaves[2].id]).toEqual({ url: 'http://localhost:3000' });
    });

    // P2-C — the tree is rebuilt with fresh pane ids, so the paneRole mirror
    // (pane-id keyed) cannot carry a role across an apply. The seed is the only
    // channel a project pane's role can travel on.
    it("carries a leaf's declared role onto the new pane's seed", () => {
      store.getState().setProjectConfig(wsId, trustedState({
        config: {
          version: 1,
          layout: {
            type: 'branch',
            direction: 'horizontal',
            children: [
              { type: 'leaf', command: 'claude', role: 'Reviewer' },
              { type: 'leaf', command: 'npm run dev' },
            ],
          },
        },
      }));
      store.getState().applyProjectLayout(wsId);
      const leaves = collectLeaves(store.getState().workspaces[0].rootPane);
      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]).toEqual({ command: 'claude', cwd: 'd:\\proj', role: 'Reviewer' });
      // A leaf with no declared role must not inherit its sibling's.
      expect(seeds[leaves[1].id].role).toBeUndefined();
    });

    it('preserves branch sizes from the config', () => {
      store.getState().setProjectConfig(wsId, trustedState());
      store.getState().applyProjectLayout(wsId);
      const root = store.getState().workspaces[0].rootPane;
      expect(root.type).toBe('branch');
      if (root.type === 'branch') expect(root.sizes).toEqual([60, 40]);
    });

    it('returns the replaced tree ptyIds for disposal', () => {
      store.setState((s) => {
        const root = s.workspaces[0].rootPane;
        if (root.type === 'leaf') {
          root.surfaces.push(createSurface('pty-1', 'pwsh', 'd:\\old'));
          root.surfaces.push(createSurface('pty-2', 'pwsh', 'd:\\old'));
        }
      });
      store.getState().setProjectConfig(wsId, trustedState());
      const result = store.getState().applyProjectLayout(wsId);
      expect(result.ok).toBe(true);
      expect(result.disposedPtyIds).toEqual(['pty-1', 'pty-2']);
    });

    it.each(['untrusted', 'stale', 'denied'] as const)('refuses when trust=%s', (trust) => {
      store.getState().setProjectConfig(wsId, trustedState({ trust }));
      const before = store.getState().workspaces[0].rootPane;
      const result = store.getState().applyProjectLayout(wsId);
      expect(result.ok).toBe(false);
      expect(store.getState().workspaces[0].rootPane).toEqual(before);
      expect(Object.keys(store.getState().projectPaneSeed)).toHaveLength(0);
    });

    it('refuses when there is no layout', () => {
      store.getState().setProjectConfig(wsId, trustedState({
        config: { version: 1, commands: [{ id: 'a', title: 'A', command: 'x' }] },
      }));
      expect(store.getState().applyProjectLayout(wsId).ok).toBe(false);
    });

    it('refuses for an unknown workspace', () => {
      store.getState().setProjectConfig(wsId, trustedState());
      expect(store.getState().applyProjectLayout('ws-nope').ok).toBe(false);
    });

    it('resets zoomedPaneId (zoom coherence)', () => {
      store.setState((s) => { s.zoomedPaneId = 'pane-old'; });
      store.getState().setProjectConfig(wsId, trustedState());
      store.getState().applyProjectLayout(wsId);
      expect(store.getState().zoomedPaneId).toBeNull();
    });

    it('carries X8 restart/restartLimit onto supervised terminal seeds', () => {
      store.getState().setProjectConfig(wsId, trustedState({
        config: {
          version: 1,
          layout: {
            type: 'branch',
            direction: 'horizontal',
            children: [
              { type: 'leaf', command: 'claude /loop', restart: 'on-failure', restartLimit: { burst: 3, healthyUptimeSec: 600 } },
              { type: 'leaf', command: 'always-loop', restart: 'always' },
              { type: 'leaf', command: 'plain' },
            ],
          },
        },
      }));
      store.getState().applyProjectLayout(wsId);
      const leaves = collectLeaves(store.getState().workspaces[0].rootPane);
      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]).toMatchObject({
        command: 'claude /loop',
        restart: 'on-failure',
        restartLimit: { burst: 3, healthyUptimeSec: 600 },
      });
      // restart with no explicit restartLimit → seed carries restart only.
      expect(seeds[leaves[1].id]?.restart).toBe('always');
      expect(seeds[leaves[1].id]?.restartLimit).toBeUndefined();
      // Unsupervised leaf → no restart fields at all.
      expect(seeds[leaves[2].id]?.restart).toBeUndefined();
      expect(seeds[leaves[2].id]?.restartLimit).toBeUndefined();
    });

    it('never carries restart fields onto a url (browser) seed', () => {
      store.getState().setProjectConfig(wsId, trustedState({
        config: {
          version: 1,
          layout: {
            type: 'branch',
            direction: 'horizontal',
            children: [
              { type: 'leaf', url: 'http://localhost:3000' },
              { type: 'leaf', command: 'x' },
            ],
          },
        },
      }));
      store.getState().applyProjectLayout(wsId);
      const leaves = collectLeaves(store.getState().workspaces[0].rootPane);
      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]).toEqual({ url: 'http://localhost:3000' });
      expect(seeds[leaves[0].id]?.restart).toBeUndefined();
    });

    it('relative cwd joins use the root separator style', () => {
      store.getState().setProjectConfig(wsId, trustedState({
        root: '/home/me/proj',
        config: {
          version: 1,
          layout: {
            type: 'branch',
            direction: 'horizontal',
            children: [
              { type: 'leaf', cwd: 'packages\\web' },
              { type: 'leaf' },
            ],
          },
        },
      }));
      store.getState().applyProjectLayout(wsId);
      const leaves = collectLeaves(store.getState().workspaces[0].rootPane);
      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]?.cwd).toBe('/home/me/proj/packages/web');
      expect(seeds[leaves[1].id]?.cwd).toBe('/home/me/proj');
    });
  });

  describe('seed/config bookkeeping', () => {
    it('clearProjectPaneSeed removes a single entry', () => {
      store.getState().setProjectConfig(wsId, trustedState());
      store.getState().applyProjectLayout(wsId);
      const ids = Object.keys(store.getState().projectPaneSeed);
      expect(ids.length).toBe(3);
      store.getState().clearProjectPaneSeed(ids[0]);
      expect(Object.keys(store.getState().projectPaneSeed)).toHaveLength(2);
    });

    it('setProjectConfig(null) deletes the entry', () => {
      store.getState().setProjectConfig(wsId, trustedState());
      store.getState().setProjectConfig(wsId, null);
      expect(store.getState().projectConfigs[wsId]).toBeUndefined();
    });

    it('markProjectLayoutAutoApplied is per-workspace', () => {
      store.getState().markProjectLayoutAutoApplied(wsId);
      expect(store.getState().projectLayoutAutoApplied[wsId]).toBe(true);
      expect(store.getState().projectLayoutAutoApplied['other']).toBeUndefined();
    });
  });

  describe('U-PERM — restorePermissionMode consent gating (buildTree)', () => {
    // A trusted project whose first leaf is a declared unattended supervised
    // agent; the sibling is a plain supervised command (no restore intent).
    function unattendedState(unattended: boolean): ProjectConfigState {
      return trustedState({
        unattended,
        config: {
          version: 1,
          layout: {
            type: 'branch',
            direction: 'horizontal',
            children: [
              { type: 'leaf', command: 'claude', restart: 'on-failure', restorePermissionMode: true },
              { type: 'leaf', command: 'npm run dev' },
            ],
          },
        },
      });
    }

    it('sets the seed bit on the unattended leaf only when the user consented', () => {
      store.getState().setProjectConfig(wsId, unattendedState(true));
      store.getState().applyProjectLayout(wsId);
      const leaves = collectLeaves(store.getState().workspaces[0].rootPane);
      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]).toMatchObject({
        command: 'claude',
        restart: 'on-failure',
        restorePermissionMode: true,
      });
      // The non-unattended sibling never carries the bit.
      expect(seeds[leaves[1].id]?.restorePermissionMode).toBeUndefined();
    });

    it('omits the bit when declared but not consented (still supervised, no bypass)', () => {
      store.getState().setProjectConfig(wsId, unattendedState(false));
      store.getState().applyProjectLayout(wsId);
      const leaves = collectLeaves(store.getState().workspaces[0].rootPane);
      const seeds = store.getState().projectPaneSeed;
      expect(seeds[leaves[0].id]?.restart).toBe('on-failure'); // supervision stays on
      expect(seeds[leaves[0].id]?.restorePermissionMode).toBeUndefined(); // but no permission restore
    });
  });
});
