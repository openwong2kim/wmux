import { describe, it, expect } from 'vitest';
import { multiviewGroupNumbers, parseMultiviewGroups } from '../multiviewGroups';

describe('multiviewGroupNumbers', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('numbers groups by where their first member sits in the sidebar', () => {
    const numbers = multiviewGroupNumbers(order, ['d', 'e'], [['b', 'a']]);
    expect(Object.fromEntries(numbers)).toEqual({ a: 1, b: 1, d: 2, e: 2 });
  });

  it('keeps each number when another group is put on screen', () => {
    const before = multiviewGroupNumbers(order, ['a', 'b'], [['d', 'e']]);
    const after = multiviewGroupNumbers(order, ['d', 'e'], [['a', 'b']]);
    expect(after).toEqual(before);
  });

  it('numbers nothing for a one-member grid', () => {
    expect(multiviewGroupNumbers(order, ['a'], []).size).toBe(0);
  });
});

describe('parseMultiviewGroups', () => {
  const live = new Set(['a', 'b', 'c', 'd']);

  it('keeps well-formed groups of live workspaces', () => {
    expect(parseMultiviewGroups([['a', 'b'], ['c', 'd']], live)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops closed workspaces, junk entries and groups left with one member', () => {
    expect(parseMultiviewGroups([['a', 'gone'], ['c', 7, 'd'], 'x', null], live)).toEqual([['c', 'd']]);
  });

  it('keeps a workspace named twice in its first group only', () => {
    expect(parseMultiviewGroups([['a', 'b'], ['b', 'c', 'd']], live)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('reads anything that is not an array as no groups', () => {
    expect(parseMultiviewGroups({ a: 1 }, live)).toEqual([]);
    expect(parseMultiviewGroups(undefined, live)).toEqual([]);
  });
});
