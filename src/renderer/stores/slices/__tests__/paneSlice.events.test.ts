import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// Capture publisher calls — paneSlice imports from this module.
const publishCalls: Array<{ fn: string; args: unknown[] }> = [];
vi.mock('../../../events/publisher', () => ({
  publishPaneCreated: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.created', args }); },
  publishPaneClosed: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.closed', args }); },
  publishPaneFocused: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.focused', args }); },
}));

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    }))
  );
}

describe('paneSlice — event publication', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;
  let rootPaneId: string;

  beforeEach(() => {
    publishCalls.length = 0;
    store = createTestStore();
    const ws = store.getState().workspaces[0];
    wsId = ws.id;
    rootPaneId = ws.rootPane.id;
  });

  describe('splitPane', () => {
    it('publishes pane.created for the new sibling', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const created = publishCalls.find((c) => c.fn === 'pane.created');
      expect(created).toBeDefined();
      expect(created?.args[0]).toBe(wsId);
      // args: (wsId, newPaneId, branchId)
      expect(typeof created?.args[1]).toBe('string');
      expect(typeof created?.args[2]).toBe('string');
    });

    it('publishes pane.focused when active pane changes', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
      // (wsId, newActiveId, previousActiveId)
      expect(focused?.args[0]).toBe(wsId);
      expect(focused?.args[2]).toBe(rootPaneId);
    });

    it('background-ws split emits pane.created but NOT pane.focused (#236 focus-scoping)', () => {
      const ws2 = createWorkspace('Background');
      store.setState((s) => { s.workspaces.push(ws2); });
      publishCalls.length = 0;

      // ws1 (rootPaneId) is active; split ws2 explicitly via its workspaceId.
      store.getState().splitPane(ws2.rootPane.id, 'horizontal', ws2.id);

      const created = publishCalls.filter((c) => c.fn === 'pane.created');
      const focused = publishCalls.filter((c) => c.fn === 'pane.focused');
      expect(created).toHaveLength(1);
      expect(created[0].args[0]).toBe(ws2.id); // pane.created scoped to ws2
      expect(focused).toHaveLength(0);          // no focus event for a background pane
    });
  });

  describe('closePane', () => {
    it('publishes pane.closed for the dropped leaf', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0; // reset so we only see closePane events

      store.getState().closePane(newPaneId);
      const closed = publishCalls.find((c) => c.fn === 'pane.closed');
      expect(closed).toBeDefined();
      expect(closed?.args).toEqual([wsId, newPaneId]);
    });

    it('publishes pane.focused when active changes after close', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0;

      store.getState().closePane(newPaneId);
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
    });
  });

  describe('setActivePane', () => {
    it('publishes pane.focused only when paneId actually changes', () => {
      // Split so we have two leaves to swap between.
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0;

      // No-op: setting the already-active pane.
      store.getState().setActivePane(newPaneId);
      expect(publishCalls.filter((c) => c.fn === 'pane.focused')).toHaveLength(0);

      // Real change.
      store.getState().setActivePane(rootPaneId);
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
      expect(focused?.args[0]).toBe(wsId);
      expect(focused?.args[1]).toBe(rootPaneId);
      expect(focused?.args[2]).toBe(newPaneId);
    });

    it('does not publish when paneId is unknown', () => {
      store.getState().setActivePane('does-not-exist');
      expect(publishCalls.filter((c) => c.fn === 'pane.focused')).toHaveLength(0);
    });
  });

  describe('cyclePane', () => {
    it('publishes pane.focused with previous active pane id', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const splitActiveId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0;

      store.getState().cyclePane('next');
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
      expect(focused?.args[0]).toBe(wsId);
      // (wsId, newActiveId, previousActiveId)
      expect(focused?.args[2]).toBe(splitActiveId);
      expect(focused?.args[1]).not.toBe(splitActiveId);
    });

    it('does not publish when only one pane exists', () => {
      publishCalls.length = 0;
      store.getState().cyclePane('next');
      expect(publishCalls.filter((c) => c.fn === 'pane.focused')).toHaveLength(0);
    });
  });

  // M0-d: paneSlice no longer exposes setPaneMetadata / getPaneMetadata /
  // clearPaneMetadata. MetadataStore in the main process is the sole writer
  // (M0-a + M0-b). The compile-time guard is the type system itself — the
  // runtime guard below asserts the methods are absent on the store state.
  describe('metadata write protect (M0-d)', () => {
    it('does not expose setPaneMetadata / getPaneMetadata / clearPaneMetadata on the slice', () => {
      const state = store.getState() as unknown as Record<string, unknown>;
      expect(state['setPaneMetadata']).toBeUndefined();
      expect(state['getPaneMetadata']).toBeUndefined();
      expect(state['clearPaneMetadata']).toBeUndefined();
    });
  });

  describe('paneNotificationRing', () => {
    it('starts empty', () => {
      expect(store.getState().paneNotificationRing).toEqual({});
    });

    it('setPaneNotificationRing(p, "flash") adds entry', () => {
      store.getState().setPaneNotificationRing(rootPaneId, 'flash');
      expect(store.getState().paneNotificationRing[rootPaneId]).toBe('flash');
    });

    it('setPaneNotificationRing(p, "glow") updates entry', () => {
      store.getState().setPaneNotificationRing(rootPaneId, 'flash');
      store.getState().setPaneNotificationRing(rootPaneId, 'glow');
      expect(store.getState().paneNotificationRing[rootPaneId]).toBe('glow');
    });

    it('setPaneNotificationRing(p, null) removes entry and keeps the map sparse', () => {
      store.getState().setPaneNotificationRing(rootPaneId, 'flash');
      store.getState().setPaneNotificationRing(rootPaneId, null);
      expect(store.getState().paneNotificationRing[rootPaneId]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(store.getState().paneNotificationRing, rootPaneId)).toBe(false);
    });

    it('closePane clears the deleted pane\'s ring entry', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      store.getState().setPaneNotificationRing(newPaneId, 'flash');
      expect(store.getState().paneNotificationRing[newPaneId]).toBe('flash');

      store.getState().closePane(newPaneId);
      expect(store.getState().paneNotificationRing[newPaneId]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(store.getState().paneNotificationRing, newPaneId)).toBe(false);
    });

    it('closePane does NOT touch other panes\' ring entries', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const wsAfterFirst = store.getState().workspaces[0];
      const newPaneId = wsAfterFirst.activePaneId;

      // After split, originalCopy and newPane are siblings. Grab the sibling id.
      const branch = wsAfterFirst.rootPane;
      if (branch.type !== 'branch') throw new Error('expected branch after split');
      const siblingId = branch.children.find((c) => c.id !== newPaneId)!.id;

      store.getState().setPaneNotificationRing(newPaneId, 'flash');
      store.getState().setPaneNotificationRing(siblingId, 'glow');

      store.getState().closePane(newPaneId);

      expect(store.getState().paneNotificationRing[newPaneId]).toBeUndefined();
      expect(store.getState().paneNotificationRing[siblingId]).toBe('glow');
    });

    it('closePane with no ring entry is a no-op (no throw)', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      // newPaneId has no ring entry — closing it must not throw.
      expect(() => store.getState().closePane(newPaneId)).not.toThrow();
      expect(store.getState().paneNotificationRing[newPaneId]).toBeUndefined();
    });
  });
});
