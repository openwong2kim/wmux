// #1091 — pure split-tree logic for remote workspaces. Deliberately its own
// tree, independent of the local pane tree (shared/types.ts Pane) — these
// tests exist so that independence stays true without ever touching a local
// workspace fixture.
import { describe, it, expect } from 'vitest';
import {
  applySizes,
  findLeaf,
  leafIds,
  reconcile,
  removeLeaf,
  splitLeaf,
  type RemotePaneNode,
} from '../remotePaneTree';

const leaf = (id: string): RemotePaneNode => ({ id, type: 'leaf' });

describe('leafIds / findLeaf', () => {
  it('returns a single id for a bare leaf', () => {
    expect(leafIds(leaf('a'))).toEqual(['a']);
  });

  it('collects every leaf id under nested branches', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), { id: 'b2', type: 'branch', direction: 'vertical', children: [leaf('b'), leaf('c')] }],
    };
    expect(leafIds(tree)).toEqual(['a', 'b', 'c']);
    expect(findLeaf(tree, 'c')?.id).toBe('c');
    expect(findLeaf(tree, 'zzz')).toBeNull();
  });
});

describe('splitLeaf', () => {
  it('turns a bare leaf into a two-child branch with even sizes', () => {
    const result = splitLeaf(leaf('a'), 'a', 'b', 'horizontal');
    expect(result.type).toBe('branch');
    if (result.type !== 'branch') throw new Error('unreachable');
    expect(result.direction).toBe('horizontal');
    expect(result.children.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.sizes).toEqual([50, 50]);
  });

  it('splits the correct leaf deep in a tree, leaving siblings untouched', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), leaf('b')],
    };
    const result = splitLeaf(tree, 'b', 'c', 'vertical');
    if (result.type !== 'branch') throw new Error('unreachable');
    expect(leafIds(result.children[0])).toEqual(['a']);
    const second = result.children[1];
    if (second.type !== 'branch') throw new Error('expected b to have split');
    expect(second.direction).toBe('vertical');
    expect(leafIds(second)).toEqual(['b', 'c']);
  });

  it('is a no-op when the target id is not in the tree', () => {
    const tree = leaf('a');
    expect(splitLeaf(tree, 'missing', 'new', 'horizontal')).toEqual(tree);
  });
});

describe('removeLeaf', () => {
  it('returns null when removing the only leaf', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
  });

  it('collapses a two-child branch into its surviving sibling', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), leaf('b')],
    };
    expect(removeLeaf(tree, 'a')).toEqual(leaf('b'));
  });

  it('collapses a three-way branch to a two-child one without collapsing further', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), leaf('b'), leaf('c')],
    };
    const result = removeLeaf(tree, 'b');
    if (result === null || result.type !== 'branch') throw new Error('expected a surviving branch');
    expect(leafIds(result)).toEqual(['a', 'c']);
  });

  it('is a no-op when the target id is not in the tree', () => {
    const tree = leaf('a');
    expect(removeLeaf(tree, 'missing')).toEqual(tree);
  });
});

describe('applySizes', () => {
  it('writes sizes onto the branch with the matching id, leaves others alone', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), leaf('b')],
      sizes: [50, 50],
    };
    const result = applySizes(tree, 'b1', [30, 70]);
    if (result.type !== 'branch') throw new Error('unreachable');
    expect(result.sizes).toEqual([30, 70]);
  });

  it('is a no-op for a bare leaf', () => {
    expect(applySizes(leaf('a'), 'b1', [1, 2])).toEqual(leaf('a'));
  });
});

describe('reconcile', () => {
  it('builds a bare leaf from a null tree with one pane id', () => {
    expect(reconcile(null, ['a'])).toEqual(leaf('a'));
  });

  it('stays null when there are no pane ids', () => {
    expect(reconcile(null, [])).toBeNull();
  });

  it('appends a new pane as a sibling branch when one already exists', () => {
    const result = reconcile(leaf('a'), ['a', 'b']);
    if (result === null || result.type !== 'branch') throw new Error('expected a new branch');
    expect(leafIds(result)).toEqual(['a', 'b']);
  });

  it('preserves an existing user-built split shape when its ids are still all wanted', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'vertical',
      children: [leaf('a'), leaf('b')],
      sizes: [30, 70],
    };
    expect(reconcile(tree, ['a', 'b'])).toEqual(tree);
  });

  it('drops a leaf whose session closed elsewhere, collapsing the branch', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), leaf('b')],
    };
    expect(reconcile(tree, ['b'])).toEqual(leaf('b'));
  });

  it('drops every leaf and returns null when the pane list goes empty', () => {
    expect(reconcile(leaf('a'), [])).toBeNull();
  });

  it('adds and drops in the same pass', () => {
    const tree: RemotePaneNode = {
      id: 'b1',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('a'), leaf('b')],
    };
    const result = reconcile(tree, ['a', 'c']);
    expect(result).not.toBeNull();
    expect(new Set(leafIds(result as RemotePaneNode))).toEqual(new Set(['a', 'c']));
  });
});
