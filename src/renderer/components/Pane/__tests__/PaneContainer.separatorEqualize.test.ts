import { describe, it, expect } from 'vitest';
import { separatorEqualizePair } from '../PaneContainer';

// #1233 — double-click a pane separator to even out the two panes it
// separates. Pure arithmetic: the two-pane case is the issue's 50/50; a
// three-plus group only touches the flanking pair.

describe('separatorEqualizePair', () => {
  it('equalizes two panes to 50/50', () => {
    expect(separatorEqualizePair([80, 20], 1)).toEqual([50, 50]);
    expect(separatorEqualizePair([12.5, 87.5], 1)).toEqual([50, 50]);
  });

  it('splits only the flanking pair, leaving other panes untouched', () => {
    // Separator between pane 0 and pane 1: their 70 combined splits evenly,
    // pane 2 keeps its 30.
    expect(separatorEqualizePair([60, 10, 30], 1)).toEqual([35, 35, 30]);
    // Separator between pane 1 and pane 2.
    expect(separatorEqualizePair([60, 10, 30], 2)).toEqual([60, 20, 20]);
  });

  it('already-even pairs stay even (idempotent)', () => {
    expect(separatorEqualizePair([50, 50], 1)).toEqual([50, 50]);
  });

  it('out-of-range indices are a no-op', () => {
    expect(separatorEqualizePair([80, 20], 0)).toEqual([80, 20]);
    expect(separatorEqualizePair([80, 20], 2)).toEqual([80, 20]);
    expect(separatorEqualizePair([80, 20], -1)).toEqual([80, 20]);
  });

  it('does not mutate the input', () => {
    const sizes = [80, 20];
    separatorEqualizePair(sizes, 1);
    expect(sizes).toEqual([80, 20]);
  });
});
