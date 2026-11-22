// Sibling collision watch, renderer half: which folder a pane is watched by,
// and how main's answer maps back to the sibling panes' tags.
import { describe, it, expect } from 'vitest';
import { paneCollision, paneWatchCwd, watchedCwds } from '../siblingCollisionWatch';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';

const term = (id: string, cwd: string, ptyId = `pty-${id}`): Surface => ({ id, ptyId, title: id, cwd } as Surface);
const leaf = (id: string, ordinal: number, surfaces: Surface[]): PaneLeaf => ({ id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '', ordinal } as PaneLeaf);
const ws = (id: string, wsOrdinal: number, leaves: PaneLeaf[]): Workspace => ({
  id,
  name: id,
  activePaneId: leaves[0].id,
  wsOrdinal,
  rootPane: leaves.length === 1 ? leaves[0] : { id: `${id}-root`, type: 'branch', direction: 'horizontal', children: leaves, sizes: leaves.map(() => 100 / leaves.length) },
} as unknown as Workspace);

describe('paneWatchCwd / watchedCwds', () => {
  it('uses a local terminal folder; a browser-only pane has none', () => {
    const a = leaf('a', 1, [term('s1', '/r/a')]);
    const browser = leaf('b', 2, [{ id: 's2', ptyId: '', title: 'web', surfaceType: 'browser', cwd: '/r/x' } as Surface]);
    const w = ws('w1', 1, [a, browser]);
    expect(paneWatchCwd(w, a)).toBe('/r/a');
    expect(paneWatchCwd(w, browser)).toBeNull();
    expect(watchedCwds([w, ws('w2', 2, [leaf('c', 1, [term('s3', '/r/a')])])])).toEqual(['/r/a']);
  });
});

describe('paneCollision', () => {
  it('names the sibling panes by tag, from main\'s snapshot', () => {
    const a = leaf('a', 1, [term('s1', '/r/a')]);
    const b = leaf('b', 1, [term('s2', '/r/b')]);
    const w1 = ws('w1', 1, [a]);
    const w2 = ws('w2', 2, [b]);
    const snapshot = {
      byCwd: {
        '/r/a': { worktreePath: '/r/a', peers: [{ worktreePath: '/r/b', conflicts: ['f.ts'], overlaps: [] }] },
        '/r/b': { worktreePath: '/r/b', peers: [{ worktreePath: '/r/a', conflicts: ['f.ts'], overlaps: [] }] },
      },
      cwdsByWorktree: { '/r/a': ['/r/a'], '/r/b': ['/r/b'] },
    };
    expect(paneCollision(snapshot, [w1, w2], w1, a)).toEqual({
      worktreePath: '/r/a',
      peers: [{ tags: ['#w2-1'], workspaceId: 'w2', paneId: 'b', worktreePath: '/r/b', conflicts: ['f.ts'], overlaps: [] }],
    });
    // The sibling's pane closed since main answered: nothing to show.
    expect(paneCollision(snapshot, [w1], w1, a)).toBeNull();
  });
});
