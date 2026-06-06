import { describe, it, expect } from 'vitest';
import { collectTerminalSurfaces } from '../paneTraversal';
import type { Pane, PaneBranch, Surface } from '../../../shared/types';

function surface(id: string, over: Partial<Surface> = {}): Surface {
  return { id, ptyId: `pty-${id}`, title: id, shell: 'pwsh', cwd: `C:\\${id}`, ...over };
}

function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}

describe('collectTerminalSurfaces', () => {
  it('returns all terminal surfaces in reading order across a split tree', () => {
    const tree: PaneBranch = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [
        leaf('p1', [surface('a'), surface('b')]),
        leaf('p2', [surface('c')]),
      ],
    };
    expect(collectTerminalSurfaces(tree).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats an undefined surfaceType as terminal', () => {
    const tree = leaf('p1', [surface('a', { surfaceType: undefined })]);
    expect(collectTerminalSurfaces(tree).map((s) => s.id)).toEqual(['a']);
  });

  it('skips browser and editor surfaces', () => {
    const tree = leaf('p1', [
      surface('term'),
      surface('web', { surfaceType: 'browser', cwd: '' }),
      surface('file', { surfaceType: 'editor', cwd: '' }),
    ]);
    expect(collectTerminalSurfaces(tree).map((s) => s.id)).toEqual(['term']);
  });

  it('returns an empty array when there are no terminals', () => {
    const tree = leaf('p1', [surface('web', { surfaceType: 'browser' })]);
    expect(collectTerminalSurfaces(tree)).toEqual([]);
  });
});
