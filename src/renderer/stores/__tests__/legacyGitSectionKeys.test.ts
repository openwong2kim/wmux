// @vitest-environment jsdom
// The sidebar Git section never shipped in a release, but dev sessions saved
// its fold and height. Those keys load harmlessly and are dropped on the next
// save (buildSessionData no longer writes them).
import { describe, expect, it } from 'vitest';
import { useStore } from '..';
import type { SessionData, Workspace } from '../../../shared/types';

describe('legacy sidebar Git section keys', () => {
  it('load without error and never land on the store', () => {
    const ws = {
      id: 'ws-1', name: 'One',
      rootPane: { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty', title: 't', shell: 'zsh', cwd: '/x', surfaceType: 'terminal' }] },
      activePaneId: 'p',
    } as unknown as Workspace;
    const data = { workspaces: [ws], activeWorkspaceId: 'ws-1', sidebarVisible: true, sidebarGitCollapsed: true, sidebarGitHeight: 999 } as unknown as SessionData;
    expect(() => useStore.getState().loadSession(data)).not.toThrow();
    const state = useStore.getState() as unknown as Record<string, unknown>;
    expect(state.sidebarGitCollapsed).toBeUndefined();
    expect(state.sidebarGitHeight).toBeUndefined();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-1']);
  });
});
