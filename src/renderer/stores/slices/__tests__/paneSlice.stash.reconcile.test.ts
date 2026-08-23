import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createSurfaceSlice, type SurfaceSlice } from '../surfaceSlice';
import { selectWorkspaceAgentRoster } from '../../selectors/workspaceAgentRoster';
import { createWorkspace, type Workspace, type Surface } from '../../../../shared/types';
import { findPane, getLeafPanes } from '../../../../shared/paneUtils';
import { stashedPaneLiveness } from '../../../../shared/paneStash';
import type { StoreState } from '../../index';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';

/**
 * End-to-end: reconcile's WRITE lands on a stashed pane, and the DERIVED
 * liveness follows (#977).
 *
 * This is the one case a source scan cannot catch. Widening only the readers
 * would leave a codebase where every grep looks right and the feature is dead:
 * reconcile decides a stashed pty is gone, calls updateSurfacePtyId to clear it,
 * a visible-tree lookup misses, the CAS logs a SKIP, and `exited` — the state
 * that tells the user their agent died while it was off-screen — is never
 * reached by any pane, ever. So the chain is exercised for real, from the store
 * action reconcile actually calls through to the row the sidebar renders.
 */

type TestState = PaneSlice & SurfaceSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
  paneGate: 'pending' | 'ready';
};

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: 'C:\\repo', surfaceType: 'terminal' };
}

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      pushToast: vi.fn(),
      zoomedPaneId: null,
      paneGate: 'ready' as const,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createSurfaceSlice(...args),
    }))
  );
}

function ws(store: ReturnType<typeof createTestStore>): Workspace {
  const s = store.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

function roster(store: ReturnType<typeof createTestStore>) {
  return selectWorkspaceAgentRoster(store.getState() as unknown as StoreState, ws(store).id);
}

describe('stashed pane liveness — reconcile write → derived state', () => {
  let store: ReturnType<typeof createTestStore>;
  let stashedPaneId: string;

  beforeEach(() => {
    setDaemonModeActive(true);
    store = createTestStore();
    const rootId = ws(store).rootPane.id;
    store.getState().splitPane(rootId, 'horizontal');
    const [, second] = getLeafPanes(ws(store).rootPane);
    stashedPaneId = second.id;
    store.setState((s) => {
      const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
      const leaf = findPane(active.rootPane, stashedPaneId);
      if (leaf && leaf.type === 'leaf') leaf.surfaces = [surface('sf-2', 'pty-2')];
      s.surfaceAgent['pty-2'] = { name: 'Claude Code', status: 'idle', slug: 'claude' };
    });
    store.getState().stashPane(stashedPaneId);
  });

  afterEach(() => {
    resetDaemonModeForTests();
    vi.restoreAllMocks();
  });

  it('starts alive and says so in the roster', () => {
    const entry = ws(store).stashedPanes![0];
    expect(stashedPaneLiveness(entry.pane)).toBe('alive');
    expect(roster(store).rows.at(-1)!.stashedLiveness).toBe('alive');
  });

  it('flips to exited when reconcile clears the pty through updateSurfacePtyId', () => {
    // Exactly what AppLayout's reconcile does on a confirmed-dead session.
    store.getState().updateSurfacePtyId(stashedPaneId, 'sf-2', '');

    const entry = ws(store).stashedPanes![0];
    expect(entry.pane.surfaces[0].ptyId).toBe('');
    expect(stashedPaneLiveness(entry.pane)).toBe('exited');

    const row = roster(store).rows.at(-1)!;
    expect(row.stashed).toBe(true);
    expect(row.stashedLiveness).toBe('exited');
    // …and it asks for the user, because a session died where nobody was looking.
    expect(row.needsAttention).toBe(true);
  });

  it('flips back to alive when reconcile REBINDS the surface to a live session', () => {
    store.getState().updateSurfacePtyId(stashedPaneId, 'sf-2', '');
    expect(roster(store).rows.at(-1)!.stashedLiveness).toBe('exited');

    // The reboot case: the session survived under a new ptyId and reconcile
    // rebinds the surface to it.
    store.getState().updateSurfacePtyId(stashedPaneId, 'sf-2', 'pty-2-reborn');

    expect(roster(store).rows.at(-1)!.stashedLiveness).toBe('alive');
  });

  it('stays alive while ANY terminal surface keeps its pty', () => {
    store.setState((s) => {
      const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
      active.stashedPanes![0].pane.surfaces.push(surface('sf-2b', 'pty-2b'));
    });

    store.getState().updateSurfacePtyId(stashedPaneId, 'sf-2', '');

    // Same rule a visible multi-tab pane follows — one live terminal is enough.
    expect(roster(store).rows.at(-1)!.stashedLiveness).toBe('alive');

    store.getState().updateSurfacePtyId(stashedPaneId, 'sf-2b', '');
    expect(roster(store).rows.at(-1)!.stashedLiveness).toBe('exited');
  });

  it('an unstashed exited pane comes back to its slot rather than self-creating', () => {
    store.getState().updateSurfacePtyId(stashedPaneId, 'sf-2', '');

    expect(store.getState().unstashPane(stashedPaneId)).toBe(true);

    const leaf = findPane(ws(store).rootPane, stashedPaneId);
    expect(leaf).not.toBeNull();
    // The surface is back with NO pty. That is the point: the empty ptyId is
    // what routes it into the existing dead-pane recovery offer, in the pane's
    // own slot, instead of a fresh shell silently wearing the old pane's name.
    expect(leaf!.type === 'leaf' && leaf!.surfaces[0].ptyId).toBe('');
    // The agent identity survived — the pane is recoverable, not replaced.
    expect(store.getState().surfaceAgent['pty-2']).toBeDefined();
  });
});
