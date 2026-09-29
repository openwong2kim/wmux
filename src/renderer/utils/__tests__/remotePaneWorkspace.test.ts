import { describe, it, expect, vi } from 'vitest';
import { createWorkspace, type Workspace } from '../../../shared/types';
import {
  createWorkspaceWithRemotePane,
  type RemotePaneWorkspaceStoreApi,
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
