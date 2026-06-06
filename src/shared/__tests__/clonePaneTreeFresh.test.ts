import { describe, it, expect } from 'vitest';
import { clonePaneTreeFresh, type Pane, type PaneBranch, type PaneLeaf, type Surface } from '../types';

function surface(over: Partial<Surface> = {}): Surface {
  return {
    id: 'surface-old',
    ptyId: 'pty-live-123',
    title: 'zsh',
    shell: '/bin/zsh',
    cwd: '/home/me/project',
    scrollbackFile: 'surface-old',
    ...over,
  };
}

function leaf(surfaces: Surface[], activeSurfaceId: string, id = 'pane-old'): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId };
}

/** Walk every surface in a tree (test helper). */
function allSurfaces(pane: Pane): Surface[] {
  return pane.type === 'leaf' ? pane.surfaces : pane.children.flatMap(allSurfaces);
}

describe('clonePaneTreeFresh', () => {
  it('regenerates pane and surface ids', () => {
    const src = leaf([surface({ id: 's1' }), surface({ id: 's2' })], 's1');
    const clone = clonePaneTreeFresh(src) as PaneLeaf;

    expect(clone.id).not.toBe(src.id);
    expect(clone.surfaces.map((s) => s.id)).not.toEqual(['s1', 's2']);
    // No id collides with the source.
    const oldIds = new Set(['s1', 's2', 'pane-old']);
    expect(clone.surfaces.every((s) => !oldIds.has(s.id))).toBe(true);
    expect(oldIds.has(clone.id)).toBe(false);
  });

  it('clears ptyId and drops scrollbackFile on every surface', () => {
    const src = leaf([surface({ id: 's1', ptyId: 'pty-a' }), surface({ id: 's2', ptyId: 'pty-b' })], 's1');
    const clone = clonePaneTreeFresh(src);
    for (const s of allSurfaces(clone)) {
      expect(s.ptyId).toBe('');
      expect(s.scrollbackFile).toBeUndefined();
    }
  });

  it('preserves shell, cwd, title, surfaceType and browser/editor pointers', () => {
    const src = leaf(
      [
        surface({ id: 's1', surfaceType: 'browser', browserUrl: 'https://example.com', browserPartition: 'persist:x' }),
        surface({ id: 's2', surfaceType: 'editor', editorFilePath: '/tmp/a.txt' }),
      ],
      's1',
    );
    const clone = clonePaneTreeFresh(src) as PaneLeaf;
    expect(clone.surfaces[0]).toMatchObject({
      surfaceType: 'browser',
      browserUrl: 'https://example.com',
      browserPartition: 'persist:x',
      shell: '/bin/zsh',
      cwd: '/home/me/project',
      title: 'zsh',
    });
    expect(clone.surfaces[1]).toMatchObject({ surfaceType: 'editor', editorFilePath: '/tmp/a.txt' });
  });

  it('keeps the active surface by position', () => {
    const src = leaf([surface({ id: 's1' }), surface({ id: 's2' }), surface({ id: 's3' })], 's2');
    const clone = clonePaneTreeFresh(src) as PaneLeaf;
    // Second surface (index 1) stays active even though its id changed.
    expect(clone.activeSurfaceId).toBe(clone.surfaces[1].id);
  });

  it('preserves branch direction and sizes and recurses into children', () => {
    const src: PaneBranch = {
      id: 'branch-old',
      type: 'branch',
      direction: 'horizontal',
      sizes: [0.3, 0.7],
      children: [leaf([surface({ id: 'a' })], 'a', 'p1'), leaf([surface({ id: 'b' })], 'b', 'p2')],
    };
    const clone = clonePaneTreeFresh(src) as PaneBranch;
    expect(clone.type).toBe('branch');
    expect(clone.direction).toBe('horizontal');
    expect(clone.sizes).toEqual([0.3, 0.7]);
    // sizes array is a copy, not a shared reference.
    expect(clone.sizes).not.toBe(src.sizes);
    expect(clone.children).toHaveLength(2);
    expect(clone.children[0].id).not.toBe('p1');
    expect(allSurfaces(clone).every((s) => s.ptyId === '')).toBe(true);
  });

  it('does not mutate the source tree', () => {
    const src = leaf([surface({ id: 's1', ptyId: 'pty-keep' })], 's1');
    clonePaneTreeFresh(src);
    expect(src.surfaces[0].ptyId).toBe('pty-keep');
    expect(src.surfaces[0].scrollbackFile).toBe('surface-old');
    expect(src.id).toBe('pane-old');
  });
});
