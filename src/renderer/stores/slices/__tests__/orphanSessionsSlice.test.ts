import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  createOrphanSessionsSlice,
  type OrphanSessionsSlice,
} from '../orphanSessionsSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, createLeafPane, type Workspace, type Pane } from '../../../../shared/types';
import { getLeafPanes } from '../../../../shared/paneUtils';

// #1101 — the orphan list is a SET DIFFERENCE: live daemon sessions minus
// every ptyId the workspaces still own (visible tree AND stash — the same
// totality getWorkspacePtyIds enforces). Adopt binds a new pane to the id and
// the row leaves the list; dispose kills via the existing pty.dispose.

type TestState = OrphanSessionsSlice & WorkspaceSlice & PaneSlice & {
  pushToast: ReturnType<typeof vi.fn>;
};

vi.stubGlobal('window', {
  electronAPI: {
    pty: {
      list: vi.fn(async () => []),
      dispose: vi.fn(async () => undefined),
    },
  },
});

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      pushToast: vi.fn(),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — same
      ...createPaneSlice(...args),
      // @ts-expect-error — same
      ...createOrphanSessionsSlice(...args),
    })),
  );
}

describe('orphanSessionsSlice', () => {
  let store: ReturnType<typeof createTestStore>;
  let ws: Workspace;

  beforeEach(() => {
    vi.mocked(window.electronAPI!.pty!.list!).mockClear();
    vi.mocked(window.electronAPI!.pty!.dispose!).mockClear();
    store = createTestStore();
    ws = createWorkspace('Test');
    store.setState((s) => {
      s.workspaces = [ws];
      s.activeWorkspaceId = ws.id;
    });
  });

  it('lists live detached sessions owned by no workspace', () => {
    // ws owns pty-owned via its tree; pty-other is orphaned.
    store.getState().setDaemonSessionInventory([
      { id: 'pty-owned', shell: '/bin/zsh', state: 'detached' },
      { id: 'pty-other', shell: '/bin/zsh', state: 'detached', workspaceId: ws.id },
      { id: 'pty-attached', shell: '/bin/zsh', state: 'attached' },
      { id: 'pty-dead', shell: '/bin/zsh', state: 'dead' },
    ]);
    const ids = store.getState().orphanSessions.map((o) => o.id);
    expect(ids).toContain('pty-other');
    expect(ids).not.toContain('pty-attached'); // owned live, not orphaned
    expect(ids).not.toContain('pty-dead'); // dead tombstones are not adoptable
  });

  it('prefers the daemon-derived agent name over the shell label', () => {
    store.getState().setDaemonSessionInventory([
      { id: 'pty-agent', shell: '/bin/zsh', state: 'detached', agentName: 'Claude Code' },
    ]);
    expect(store.getState().orphanSessions[0].label).toBe('Claude Code');
    store.getState().setDaemonSessionInventory([
      { id: 'pty-shell', shell: 'C:\\Windows\\System32\\wsl.exe', state: 'detached' },
    ]);
    expect(store.getState().orphanSessions[0].label).toBe('WSL');
  });

  it('counts a stashed pane\'s pty as owned — stash is not orphaning', () => {
    const visible = createLeafPane();
    visible.surfaces = [{ id: 'sf-1', ptyId: 'pty-visible', title: '', shell: '', cwd: '' }];
    visible.activeSurfaceId = 'sf-1';
    const stashed = createLeafPane();
    stashed.surfaces = [{ id: 'sf-2', ptyId: 'pty-stashed', title: '', shell: '', cwd: '' }];
    stashed.activeSurfaceId = 'sf-2';
    const root: Pane = { id: 'branch-1', type: 'branch', direction: 'horizontal', children: [visible] };
    store.setState((s) => {
      s.workspaces[0].rootPane = root;
      s.workspaces[0].activePaneId = visible.id;
      s.workspaces[0].stashedPanes = [{ pane: stashed, stashedAt: 1 }];
    });
    store.getState().setDaemonSessionInventory([
      { id: 'pty-stashed', shell: '/bin/zsh', state: 'detached' },
      { id: 'pty-other', shell: '/bin/zsh', state: 'detached' },
    ]);
    const ids = store.getState().orphanSessions.map((o) => o.id);
    expect(ids).not.toContain('pty-stashed');
    expect(ids).toContain('pty-other');
  });

  it('adopt binds a new pane to the session id and activates it', () => {
    store.getState().setDaemonSessionInventory([
      { id: 'pty-orphan', shell: '/bin/zsh', state: 'detached', workspaceId: ws.id, cwd: '/repo' },
    ]);
    const paneId = store.getState().adoptOrphanSession('pty-orphan');
    expect(paneId).toBeTruthy();
    const state = store.getState();
    const w = state.workspaces[0];
    const leaves = getLeafPanes(w.rootPane);
    expect(leaves).toHaveLength(2);
    const adopted = leaves.find((l) => l.id === paneId)!;
    expect(adopted.surfaces[0].ptyId).toBe('pty-orphan');
    expect(adopted.surfaces[0].cwd).toBe('/repo');
    expect(w.activePaneId).toBe(paneId);
    // The row left the list the moment it became owned.
    expect(state.orphanSessions).toHaveLength(0);
  });

  it('adopt prefers the origin workspace, falling back to the active one', () => {
    const ws2 = createWorkspace('Second');
    store.setState((s) => { s.workspaces = [ws, ws2]; });
    store.getState().setDaemonSessionInventory([
      { id: 'pty-orphan', shell: '/bin/zsh', state: 'detached', workspaceId: 'ws-gone' },
    ]);
    const paneId = store.getState().adoptOrphanSession('pty-orphan');
    expect(paneId).toBeTruthy();
    // No origin workspace → active workspace (ws) adopts.
    expect(store.getState().workspaces[0].activePaneId).toBe(paneId);
  });

  it('dispose kills via pty.dispose and refreshes', async () => {
    store.getState().setDaemonSessionInventory([
      { id: 'pty-orphan', shell: '/bin/zsh', state: 'detached' },
    ]);
    await store.getState().disposeOrphanSession('pty-orphan');
    expect(window.electronAPI!.pty!.dispose).toHaveBeenCalledWith('pty-orphan');
    expect(store.getState().orphanSessions).toHaveLength(0);
  });

  it('adopt of an unknown id is a safe null', () => {
    expect(store.getState().adoptOrphanSession('nope')).toBeNull();
  });
});
