import { describe, it, expect } from 'vitest';
import { balancePaneSizes } from '../paneUtils';
import type { Pane, PaneBranch, PaneLeaf } from '../types';

const leaf = (id: string): PaneLeaf => ({ id, type: 'leaf', surfaces: [], activeSurfaceId: '' });
const branch = (
  id: string,
  direction: PaneBranch['direction'],
  children: Pane[],
  sizes?: number[],
): PaneBranch => ({ id, type: 'branch', direction, children, sizes });

describe('balancePaneSizes', () => {
  it('leaves a lone leaf untouched', () => {
    const root = leaf('a');
    balancePaneSizes(root);
    expect(root).toEqual(leaf('a'));
  });

  it('splits a flat row of 7 into sevenths, overwriting skewed sizes', () => {
    const root = branch('r', 'horizontal', ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(leaf), [50, 10, 10, 10, 10, 5, 5]);
    balancePaneSizes(root);
    root.sizes!.forEach((s) => expect(s).toBeCloseTo(100 / 7));
  });

  it('gives every column the same width when some columns are stacks, and splits each stack evenly', () => {
    const stack2 = branch('s2', 'vertical', [leaf('b'), leaf('c')], [80, 20]);
    const stack3 = branch('s3', 'vertical', [leaf('e'), leaf('f'), leaf('g')], [70, 20, 10]);
    const root = branch('r', 'horizontal', [leaf('a'), stack2, leaf('d'), stack3], [10, 60, 10, 20]);
    balancePaneSizes(root);
    expect(root.sizes).toEqual([25, 25, 25, 25]);
    expect(stack2.sizes).toEqual([50, 50]);
    stack3.sizes!.forEach((s) => expect(s).toBeCloseTo(100 / 3));
  });

  it('weights a column that is split sideways inside a stack by the slots it needs', () => {
    // [ a | (b over (c | d)) ] -> the right column holds a 2-wide row, so it needs 2 slots.
    const inner = branch('in', 'horizontal', [leaf('c'), leaf('d')], [90, 10]);
    const col = branch('col', 'vertical', [leaf('b'), inner]);
    const root = branch('r', 'horizontal', [leaf('a'), col]);
    balancePaneSizes(root);
    expect(root.sizes![0]).toBeCloseTo(100 / 3);
    expect(root.sizes![1]).toBeCloseTo(200 / 3);
    expect(col.sizes).toEqual([50, 50]);
    expect(inner.sizes).toEqual([50, 50]);
  });

  it('always yields sizes that sum to 100 and match the child count', () => {
    const root = branch('r', 'vertical', [
      branch('x', 'horizontal', [leaf('a'), leaf('b'), leaf('c')]),
      leaf('d'),
    ]);
    balancePaneSizes(root);
    expect(root.sizes).toEqual([50, 50]);
    const x = root.children[0] as PaneBranch;
    expect(x.sizes).toHaveLength(3);
    expect(x.sizes!.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });
});
