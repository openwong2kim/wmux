import { describe, it, expect, vi } from 'vitest';
import { createLeafPane, createRemoteSurface, createWorkspace, type Pane, type Workspace } from '../../../shared/types';
import { formatShadowWorkspaceId } from '../../../shared/pcRail';
import {
  createWorkspaceWithRemotePane,
  openRemoteSessionAsTab,
  type RemotePaneWorkspaceStoreApi,
  type RemoteSessionTabStoreApi,
} from '../remotePaneWorkspace';

// #1323 — the + menu's "Empty — remote" row. The helper is the only new glue
// between AddRemotePaneModal's mint and the store: which pane receives the
// session, and what happens when there is none.

const MINTED = { hostId: 'host-1', sessionId: 'sess-1', remoteWorkspaceId: 'remote-pane-abc' };

function fakeStore(opts: { addWorkspaceIsNoop?: boolean } = {}) {
  const steps: string[] = [];
  const state: RemotePaneWorkspaceStoreApi & { workspaces: Workspace[] } = {
    workspaces: [createWorkspace('Existing', 1)],
    addWorkspace: vi.fn(() => {
      steps.push('addWorkspace');
      if (!opts.addWorkspaceIsNoop) state.workspaces.push(createWorkspace('Workspace 2', 2));
    }),
    addRemoteSurface: vi.fn(() => { steps.push('addRemoteSurface'); }),
  };
  return { state, steps };
}

describe('createWorkspaceWithRemotePane (#1323)', () => {
  it('attaches the minted session to the new workspace’s leaf as an owned remote surface', () => {
    const { state } = fakeStore();
    const destroy = vi.fn();

    const wsId = createWorkspaceWithRemotePane(() => state, destroy, MINTED);

    const created = state.workspaces[1];
    expect(wsId).toBe(created.id);
    expect(state.addRemoteSurface).toHaveBeenCalledTimes(1);
    // Same argument shape as Pane.tsx's handleRemoteCreated: owned (the desk
    // minted it, #1129) and the host-side workspace id (#1329), targeted at
    // the NEW workspace explicitly rather than whatever is active.
    expect(state.addRemoteSurface).toHaveBeenCalledWith(
      created.rootPane.id, 'host-1', 'sess-1', undefined, undefined, created.id, true, 'remote-pane-abc',
    );
    expect(destroy).not.toHaveBeenCalled();
  });

  it('never touches an existing workspace', () => {
    const { state } = fakeStore();
    const existingLeafId = state.workspaces[0].rootPane.id;

    createWorkspaceWithRemotePane(() => state, vi.fn(), MINTED);

    const [paneId, , , , , workspaceId] = (state.addRemoteSurface as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(paneId).not.toBe(existingLeafId);
    expect(workspaceId).not.toBe(state.workspaces[0].id);
  });

  it('creates the workspace and attaches in back-to-back calls, nothing in between', () => {
    const { state, steps } = fakeStore();
    createWorkspaceWithRemotePane(() => state, vi.fn(), MINTED);
    expect(steps).toEqual(['addWorkspace', 'addRemoteSurface']);
  });

  it('destroys the minted session when no workspace was created to hold it', () => {
    const { state } = fakeStore({ addWorkspaceIsNoop: true });
    const destroy = vi.fn();

    const wsId = createWorkspaceWithRemotePane(() => state, destroy, MINTED);

    expect(wsId).toBeNull();
    expect(state.addRemoteSurface).not.toHaveBeenCalled();
    // Nothing else would ever reap it (#1129's orphan).
    expect(destroy).toHaveBeenCalledWith([{ hostId: 'host-1', sessionId: 'sess-1' }]);
  });
});

// #1323 item 2 — a session the mirror grid is showing, opened as a tab in one
// of this computer's workspaces. Nothing is minted, so the tab must never own
// (and on close destroy) the host's session.
describe('openRemoteSessionAsTab (#1323 item 2)', () => {
  const MIRRORED = { hostId: 'host-1', sessionId: 'sess-1', remoteWorkspaceId: 'ws-on-host' };

  /** A store whose addRemoteSurface really adds the tab, so the returned id
   *  can be checked against what landed. */
  function tabStore(workspaces: Workspace[], hqId: string | null = null) {
    const state: RemoteSessionTabStoreApi & { workspaces: Workspace[] } = {
      workspaces,
      moa: null,
      moaHqSeed: hqId,
      addRemoteSurface: vi.fn((paneId: string, hostId: string, sessionId: string, shell?: string, cwd?: string,
        workspaceId?: string, owned?: boolean, remoteWorkspaceId?: string) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        const leaves: Pane[] = ws ? [ws.rootPane] : [];
        while (leaves.length > 0) {
          const p = leaves.shift() as Pane;
          if (p.type === 'branch') { leaves.push(...p.children); continue; }
          if (p.id !== paneId) continue;
          const surface = createRemoteSurface(hostId, sessionId, shell ?? '', cwd ?? '', owned === true, remoteWorkspaceId);
          p.surfaces.push(surface);
          p.activeSurfaceId = surface.id;
        }
      }),
    };
    return state;
  }

  /** A workspace split in two, with the SECOND leaf active. */
  function splitWorkspace(name: string, ordinal: number): Workspace {
    const ws = createWorkspace(name, ordinal);
    const first = ws.rootPane;
    const second = createLeafPane();
    ws.rootPane = { id: `branch-${ordinal}`, type: 'branch', direction: 'horizontal', children: [first, second], sizes: [50, 50] };
    ws.activePaneId = second.id;
    return ws;
  }

  it('adds a NOT-owned tab to the target workspace’s active pane, with the host workspace id', () => {
    const target = splitWorkspace('Target', 2);
    const state = tabStore([createWorkspace('Other', 1), target]);

    const surfaceId = openRemoteSessionAsTab(() => state, target.id, MIRRORED);

    expect(state.addRemoteSurface).toHaveBeenCalledTimes(1);
    // owned: false (the session is somebody's running work, #1129); the host
    // workspace id rides along for the agent roster (#1329).
    expect(state.addRemoteSurface).toHaveBeenCalledWith(
      target.activePaneId, 'host-1', 'sess-1', undefined, undefined, target.id, false, 'ws-on-host',
    );
    const active = (target.rootPane.type === 'branch' ? target.rootPane.children[1] : null) as Pane;
    expect(active.type === 'leaf' && active.surfaces[0]?.id).toBe(surfaceId);
    expect(active.type === 'leaf' && active.surfaces[0]?.remoteOwned).toBeUndefined();
  });

  it('falls back to the first pane when the active pane id does not resolve', () => {
    const target = createWorkspace('Target', 1);
    target.activePaneId = 'gone';
    const state = tabStore([target]);

    openRemoteSessionAsTab(() => state, target.id, MIRRORED);

    expect((state.addRemoteSurface as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(target.rootPane.id);
  });

  it('refuses another computer’s (shadow) workspace, the Moa HQ and an unknown one', () => {
    const shadow = createWorkspace('Shadow', 1);
    shadow.id = formatShadowWorkspaceId('host-2', 'remote-ws') ?? '';
    expect(shadow.id).not.toBe('');
    const hq = createWorkspace('Moa', 2);
    const state = tabStore([shadow, hq], hq.id);

    expect(openRemoteSessionAsTab(() => state, shadow.id, MIRRORED)).toBeNull();
    expect(openRemoteSessionAsTab(() => state, hq.id, MIRRORED)).toBeNull();
    expect(openRemoteSessionAsTab(() => state, 'no-such-workspace', MIRRORED)).toBeNull();
    expect(state.addRemoteSurface).not.toHaveBeenCalled();
  });
});
