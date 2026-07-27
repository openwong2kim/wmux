// PR-9 keep-warm LRU — pure eviction order.
import { describe, it, expect } from 'vitest';
import {
  keepWarmSet,
  promoteToggle,
  dropToggle,
  KEEP_WARM_DEFAULT_N,
  TOGGLE_ORDER_MAX,
} from '../keepWarmLru';

describe('keepWarmSet', () => {
  it('keeps the N most recently used panes and evicts the rest', () => {
    const warm = keepWarmSet(['a', 'b', 'c', 'd', 'e', 'f'], 4);
    expect([...warm]).toEqual(['a', 'b', 'c', 'd']);
    expect(warm.has('e')).toBe(false);
    expect(warm.has('f')).toBe(false);
  });

  it('defaults to N=4', () => {
    expect(KEEP_WARM_DEFAULT_N).toBe(4);
    expect(keepWarmSet(['a', 'b', 'c', 'd', 'e']).size).toBe(4);
  });

  it('keeps nothing at n=0 (or negative)', () => {
    expect(keepWarmSet(['a', 'b', 'c'], 0).size).toBe(0);
    expect(keepWarmSet(['a', 'b', 'c'], -1).size).toBe(0);
  });

  it('keeps everything when fewer panes than slots', () => {
    expect([...keepWarmSet(['a', 'b'], 4)]).toEqual(['a', 'b']);
  });

  it('is empty for an empty order', () => {
    expect(keepWarmSet([], 4).size).toBe(0);
  });

  it('counts a duplicated entry once, so a slot is not wasted', () => {
    // A defensive case: the store dedups on promote, but a duplicate must never
    // cost a live pane its warm slot.
    expect([...keepWarmSet(['a', 'a', 'b', 'c', 'd', 'e'], 4)]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores empty ptyIds', () => {
    expect([...keepWarmSet(['', 'a', ''], 2)]).toEqual(['a']);
  });
});

describe('promoteToggle', () => {
  it('puts a new pane at the MRU head', () => {
    expect(promoteToggle(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('MOVES an already-tracked pane instead of inserting it (duplicate toggles)', () => {
    expect(promoteToggle(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(promoteToggle(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });

  it('re-toggling a warm pane does not evict a different warm pane', () => {
    const order = promoteToggle(['a', 'b', 'c', 'd'], 'd');
    expect([...keepWarmSet(order, 4)]).toEqual(['d', 'a', 'b', 'c']);
  });

  it('caps the tracked order', () => {
    let order: string[] = [];
    for (let i = 0; i < TOGGLE_ORDER_MAX + 10; i += 1) order = promoteToggle(order, `p${i}`);
    expect(order.length).toBe(TOGGLE_ORDER_MAX);
    expect(order[0]).toBe(`p${TOGGLE_ORDER_MAX + 9}`);
  });

  it('is a no-op for an empty ptyId', () => {
    expect(promoteToggle(['a'], '')).toEqual(['a']);
  });

  it('does not mutate its input', () => {
    const input = ['a', 'b'];
    promoteToggle(input, 'b');
    expect(input).toEqual(['a', 'b']);
  });
});

describe('dropToggle', () => {
  it('removes the pane and promotes the next one into the warm set', () => {
    const order = dropToggle(['a', 'b', 'c', 'd', 'e'], 'b');
    expect(order).toEqual(['a', 'c', 'd', 'e']);
    expect([...keepWarmSet(order, 4)]).toEqual(['a', 'c', 'd', 'e']);
  });

  it('is a no-op for an untracked pane', () => {
    expect(dropToggle(['a'], 'zz')).toEqual(['a']);
  });
});
