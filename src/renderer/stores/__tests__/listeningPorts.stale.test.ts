// @vitest-environment jsdom
//
// #1135 — the sidebar's listening-port chip must never outlive the ports.
//
// Two independent leaks are covered here:
//   1. a saved session restoring `metadata.listeningPorts` verbatim (the chip
//      survived a full app restart, because the daemon's PortWatcher treats
//      its first empty observation for a session as "nothing to clear");
//   2. a surface that owned the ports being closed, which deletes the
//      per-surface entry but used to leave the workspace-level union frozen.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../index';
import type { SessionData, Workspace } from '../../../shared/types';

function makeWs(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf',
      type: 'leaf',
      activeSurfaceId: 's1',
      surfaces: [
        { id: 's1', ptyId: 'pty-1', title: 'a', shell: 'bash', cwd: '/tmp', surfaceType: 'terminal' },
        { id: 's2', ptyId: 'pty-2', title: 'b', shell: 'bash', cwd: '/tmp', surfaceType: 'terminal' },
      ],
    },
    activePaneId: 'leaf',
    metadata: { listeningPorts: [18856, 63361] },
  } as unknown as Workspace;
}

function load(): void {
  const data: SessionData = {
    workspaces: [makeWs()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  useStore.getState().loadSession(data);
}

describe('#1135 stale listening-port badge', () => {
  beforeEach(() => {
    // The store is a module singleton — drop any per-surface ports a previous
    // case left behind before restoring the fixture session.
    const s = useStore.getState();
    for (const id of Object.keys(s.surfacePorts)) s.setSurfacePorts(id, null);
    load();
  });

  it('drops persisted listeningPorts on session load', () => {
    const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-1');
    expect(ws?.metadata?.listeningPorts).toBeUndefined();
  });

  it('recomputes the workspace union when a port-owning surface closes', () => {
    const s = useStore.getState();
    s.setSurfacePorts('pty-1', [3000]);
    s.setSurfacePorts('pty-2', [8080]);
    s.updateWorkspaceMetadata('ws-1', { listeningPorts: [3000, 8080] });

    useStore.getState().closeSurface('leaf', 's2', 'ws-1');

    const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-1');
    expect(useStore.getState().surfacePorts['pty-2']).toBeUndefined();
    expect(ws?.metadata?.listeningPorts).toEqual([3000]);
  });

  it('clears the chip entirely when the last port-owning surface closes', () => {
    const s = useStore.getState();
    s.setSurfacePorts('pty-2', [8080]);
    s.updateWorkspaceMetadata('ws-1', { listeningPorts: [8080] });

    useStore.getState().closeSurface('leaf', 's2', 'ws-1');

    const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-1');
    expect(ws?.metadata?.listeningPorts).toEqual([]);
  });
});
