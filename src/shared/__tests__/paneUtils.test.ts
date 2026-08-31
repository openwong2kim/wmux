import { describe, it, expect } from 'vitest';
import {
  findLeaf,
  findPane,
  findParent,
  collectLeafIds,
  getLeafPanes,
  getWorkspaceLeafPanes,
  collectPaneTreePtyIds,
  getWorkspacePtyIds,
  collectPaneTreeRemoteSessions,
  getWorkspaceRemoteSessions,
} from '../paneUtils';
import type { Pane, PaneLeaf, PaneBranch } from '../types';

// Test fixture:
//   root (branch, horizontal)
//   ├── leaf-1 (leaf)
//   └── sub (branch, vertical)
//       ├── leaf-2 (leaf)
//       └── leaf-3 (leaf)

const leaf1: PaneLeaf = { id: 'leaf-1', type: 'leaf', surfaces: [], activeSurfaceId: '' };
const leaf2: PaneLeaf = { id: 'leaf-2', type: 'leaf', surfaces: [], activeSurfaceId: '' };
const leaf3: PaneLeaf = { id: 'leaf-3', type: 'leaf', surfaces: [], activeSurfaceId: '' };

const subBranch: PaneBranch = {
  id: 'sub',
  type: 'branch',
  direction: 'vertical',
  children: [leaf2, leaf3],
};

const root: PaneBranch = {
  id: 'root',
  type: 'branch',
  direction: 'horizontal',
  children: [leaf1, subBranch],
};

describe('findLeaf', () => {
  it('finds a leaf by ID in a flat tree', () => {
    const singleLeaf: PaneLeaf = { id: 'only', type: 'leaf', surfaces: [], activeSurfaceId: '' };
    expect(findLeaf(singleLeaf, 'only')).toBe(singleLeaf);
  });

  it('finds a leaf in a nested branch tree', () => {
    const result = findLeaf(root, 'leaf-3');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('leaf-3');
  });

  it('returns null for non-existent ID', () => {
    expect(findLeaf(root, 'no-such-id')).toBeNull();
  });

  it('returns null when searching for a branch ID (it only finds leaves)', () => {
    expect(findLeaf(root, 'sub')).toBeNull();
    expect(findLeaf(root, 'root')).toBeNull();
  });
});

describe('findPane', () => {
  it('finds both leaves and branches', () => {
    expect(findPane(root, 'leaf-1')!.id).toBe('leaf-1');
    expect(findPane(root, 'sub')!.id).toBe('sub');
    expect(findPane(root, 'root')!.id).toBe('root');
  });

  it('returns null for non-existent ID', () => {
    expect(findPane(root, 'missing')).toBeNull();
  });
});

describe('findParent', () => {
  it('returns the parent branch of a leaf', () => {
    const parent = findParent(root, 'leaf-2');
    expect(parent).not.toBeNull();
    expect(parent!.id).toBe('sub');
  });

  it('returns the root as parent for a direct child', () => {
    const parent = findParent(root, 'leaf-1');
    expect(parent).not.toBeNull();
    expect(parent!.id).toBe('root');
  });

  it('returns null for the root pane', () => {
    expect(findParent(root, 'root')).toBeNull();
  });
});

describe('collectLeafIds', () => {
  it('returns all leaf IDs in depth-first order', () => {
    expect(collectLeafIds(root)).toEqual(['leaf-1', 'leaf-2', 'leaf-3']);
  });

  it('returns single ID for a lone leaf', () => {
    expect(collectLeafIds(leaf1)).toEqual(['leaf-1']);
  });
});

describe('getLeafPanes', () => {
  it('returns all leaf panes', () => {
    const leaves = getLeafPanes(root);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((l) => l.id)).toEqual(['leaf-1', 'leaf-2', 'leaf-3']);
  });

  it('returns the pane itself when it is a leaf', () => {
    const leaves = getLeafPanes(leaf1);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].id).toBe('leaf-1');
  });
});

// ─── Workspace-wide walks (visible tree + stash) ─────────────────────────────

const surfaced: PaneLeaf = {
  id: 'leaf-s',
  type: 'leaf',
  activeSurfaceId: 's1',
  surfaces: [
    { id: 's1', ptyId: 'pty-1', title: '', shell: '', cwd: '' },
    { id: 's2', ptyId: '', title: '', shell: '', cwd: '' },
    { id: 's3', ptyId: 'pty-2', title: '', shell: '', cwd: '' },
  ],
};

describe('getWorkspaceLeafPanes', () => {
  it('returns only the visible tree when nothing is stashed', () => {
    expect(getWorkspaceLeafPanes({ rootPane: root }).map((l) => l.id))
      .toEqual(['leaf-1', 'leaf-2', 'leaf-3']);
    expect(getWorkspaceLeafPanes({ rootPane: root, stashedPanes: [] }).map((l) => l.id))
      .toEqual(['leaf-1', 'leaf-2', 'leaf-3']);
  });

  it('appends stashed panes after the visible ones', () => {
    const stashed: PaneLeaf = { id: 'leaf-x', type: 'leaf', surfaces: [], activeSurfaceId: '' };
    const leaves = getWorkspaceLeafPanes({ rootPane: root, stashedPanes: [{ pane: stashed }] });
    expect(leaves.map((l) => l.id)).toEqual(['leaf-1', 'leaf-2', 'leaf-3', 'leaf-x']);
  });

  it('skips malformed stash entries instead of throwing', () => {
    const stashed: PaneLeaf = { id: 'leaf-x', type: 'leaf', surfaces: [], activeSurfaceId: '' };
    const leaves = getWorkspaceLeafPanes({
      rootPane: leaf1,
      stashedPanes: [
        null,
        undefined,
        {} as { pane?: Pane },
        { pane: subBranch },
        { pane: stashed },
      ],
    });
    expect(leaves.map((l) => l.id)).toEqual(['leaf-1', 'leaf-x']);
  });
});

describe('collectPaneTreePtyIds / getWorkspacePtyIds', () => {
  it('collects every bound ptyId and skips the unbound ones', () => {
    expect(collectPaneTreePtyIds(surfaced)).toEqual(['pty-1', 'pty-2']);
    expect(collectPaneTreePtyIds(root)).toEqual([]);
  });

  it('includes stashed panes at the workspace level', () => {
    const stashed: PaneLeaf = {
      id: 'leaf-x',
      type: 'leaf',
      activeSurfaceId: 'sx',
      surfaces: [{ id: 'sx', ptyId: 'pty-stashed', title: '', shell: '', cwd: '' }],
    };
    expect(getWorkspacePtyIds({ rootPane: surfaced })).toEqual(['pty-1', 'pty-2']);
    expect(getWorkspacePtyIds({ rootPane: surfaced, stashedPanes: [{ pane: stashed }] }))
      .toEqual(['pty-1', 'pty-2', 'pty-stashed']);
  });
});

// #1129 — the remote counterpart of the PTY walks. A remote-terminal surface
// carries no ptyId, so the walks above are structurally blind to it.
describe('collectPaneTreeRemoteSessions / getWorkspaceRemoteSessions', () => {
  const remoteLeaf: PaneLeaf = {
    id: 'leaf-r',
    type: 'leaf',
    activeSurfaceId: 'r1',
    surfaces: [
      // owned — this desktop minted it
      { id: 'r1', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h1', remoteSessionId: 'web-1', remoteOwned: true },
      // a VIEW of somebody else's session — never a destroy target
      { id: 'r2', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h1', remoteSessionId: 'web-2' },
      // an ordinary local terminal shares the leaf
      { id: 'r3', ptyId: 'pty-9', title: '', shell: '', cwd: '' },
    ],
  };

  it('collects only the sessions this desktop owns', () => {
    expect(collectPaneTreeRemoteSessions(remoteLeaf)).toEqual([{ hostId: 'h1', sessionId: 'web-1' }]);
  });

  it('returns nothing for a tree with no remote surfaces', () => {
    expect(collectPaneTreeRemoteSessions(surfaced)).toEqual([]);
  });

  it('skips an owned surface whose host/session pointer is missing', () => {
    const broken: PaneLeaf = {
      id: 'leaf-b',
      type: 'leaf',
      activeSurfaceId: 'b1',
      surfaces: [{ id: 'b1', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteOwned: true }],
    };
    expect(collectPaneTreeRemoteSessions(broken)).toEqual([]);
  });

  it('includes stashed panes at the workspace level', () => {
    const stashed: PaneLeaf = {
      id: 'leaf-x',
      type: 'leaf',
      activeSurfaceId: 'sx',
      surfaces: [{ id: 'sx', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h2', remoteSessionId: 'web-stashed', remoteOwned: true }],
    };
    expect(getWorkspaceRemoteSessions({ rootPane: remoteLeaf })).toEqual([{ hostId: 'h1', sessionId: 'web-1' }]);
    expect(getWorkspaceRemoteSessions({ rootPane: remoteLeaf, stashedPanes: [{ pane: stashed }] })).toEqual([
      { hostId: 'h1', sessionId: 'web-1' },
      { hostId: 'h2', sessionId: 'web-stashed' },
    ]);
  });
});
