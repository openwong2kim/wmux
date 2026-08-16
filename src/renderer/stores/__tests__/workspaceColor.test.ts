/**
 * Workspace color tag — store contract.
 *
 * The tag is cosmetic, but it is persisted, so the two things worth pinning
 * are: (1) set/clear round-trips through the store, and (2) a session file
 * carrying a value this build does not know loses the value, not the session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import type { SessionData, Workspace } from '../../../shared/types';

function makeWorkspace(id: string, name: string, color?: unknown): Workspace {
  return {
    id,
    name,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 't', shell: 'zsh', cwd: '/x' }],
      activeSurfaceId: `${id}-surf`,
    },
    activePaneId: `${id}-pane`,
    ...(color === undefined ? {} : { color }),
  } as unknown as Workspace;
}

function loadWith(workspaces: Workspace[]): void {
  useStore.getState().loadSession({
    workspaces,
    activeWorkspaceId: workspaces[0]?.id,
    sidebarVisible: true,
  } as unknown as SessionData);
}

const wsById = (id: string) => useStore.getState().workspaces.find((w) => w.id === id);

beforeEach(() => {
  loadWith([makeWorkspace('ws-1', 'Alpha'), makeWorkspace('ws-2', 'Bravo')]);
});

describe('setWorkspaceColor', () => {
  it('sets a known color and leaves other workspaces untouched', () => {
    useStore.getState().setWorkspaceColor('ws-1', 'blue');
    expect(wsById('ws-1')?.color).toBe('blue');
    expect(wsById('ws-2')?.color).toBeUndefined();
  });

  it('clears the tag with undefined (field is removed, not set to null)', () => {
    useStore.getState().setWorkspaceColor('ws-1', 'green');
    useStore.getState().setWorkspaceColor('ws-1', undefined);
    expect(wsById('ws-1')).not.toHaveProperty('color');
  });

  it('ignores an unknown workspace id', () => {
    expect(() => useStore.getState().setWorkspaceColor('nope', 'red')).not.toThrow();
  });
});

describe('loadSession color normalization', () => {
  it('keeps valid tags and drops unknown ones', () => {
    loadWith([
      makeWorkspace('ws-1', 'Alpha', 'purple'),
      makeWorkspace('ws-2', 'Bravo', 'chartreuse'),
      makeWorkspace('ws-3', 'Chi', 123),
    ]);
    expect(wsById('ws-1')?.color).toBe('purple');
    expect(wsById('ws-2')?.color).toBeUndefined();
    expect(wsById('ws-3')?.color).toBeUndefined();
    // The rest of the session still loaded — a bad tag is never fatal.
    expect(useStore.getState().workspaces).toHaveLength(3);
  });
});
