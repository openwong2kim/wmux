import { describe, expect, it, vi } from 'vitest';
import { applyAcceptedLocationProjection } from '../useNotificationListener';
import type { SessionLocationSnapshot } from '../../../shared/sessionLocation';

function snapshot(cwd: string): SessionLocationSnapshot {
  return {
    generation: 1,
    revision: 2,
    location: { domain: 'wsl', cwd, shell: 'wsl.exe', distro: 'Ubuntu' },
  };
}

function state(accepted: boolean) {
  const rootPane = {
    id: 'pane-1',
    type: 'leaf',
    activeSurfaceId: 'surface-1',
    surfaces: [{ id: 'surface-1', ptyId: 'pty-1', surfaceType: 'terminal' }],
  };
  return {
    activeWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1', activePaneId: 'pane-1', rootPane }],
    updateSurfaceLocation: vi.fn(() => accepted),
    updateWorkspaceMetadata: vi.fn(),
    getMissionForPaneGroup: vi.fn(() => ({ worktreePath: 'C:/repo' })),
    setPaneGroupDeparted: vi.fn(),
  };
}

describe('accepted location notification side effects', () => {
  it('updates workspace cwd and departed state from the accepted atomic snapshot', () => {
    const store = state(true);

    expect(applyAcceptedLocationProjection(
      store as never,
      'pty-1',
      snapshot('C:/elsewhere'),
    )).toBe(true);

    expect(store.updateWorkspaceMetadata).toHaveBeenCalledWith('ws-1', {
      cwd: 'C:/elsewhere',
    });
    expect(store.setPaneGroupDeparted).toHaveBeenCalledWith('ws-1', 'C:/elsewhere');
  });

  it('does not apply cwd side effects for a stale snapshot', () => {
    const store = state(false);

    expect(applyAcceptedLocationProjection(
      store as never,
      'pty-1',
      snapshot('C:/stale'),
    )).toBe(false);

    expect(store.updateWorkspaceMetadata).not.toHaveBeenCalled();
    expect(store.setPaneGroupDeparted).not.toHaveBeenCalled();
  });
});
