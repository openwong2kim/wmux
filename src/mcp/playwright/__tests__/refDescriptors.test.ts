import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignStableRefs,
  clearRefDescriptors,
  describeRetiredRef,
  DESCRIPTOR_GENERATIONS,
  nextRefFor,
  priorRefDescriptors,
  recordRefGeneration,
  recoveredRefNote,
  reserveRefs,
  uniqueDescriptorMatch,
} from '../refDescriptors';

// The one descriptor match behind both halves of #1355: the number an element
// keeps across a re-snapshot, and the old ref that can still be resolved.

beforeEach(() => clearRefDescriptors());

const el = (role: string, name: string) => ({ role, name });

describe('assignStableRefs', () => {
  it('numbers from the seed when there is no history', () => {
    const out = assignStableRefs([], 0, [el('link', 'Home'), el('link', 'Reports')]);
    expect(out.refs).toEqual([0, 1]);
    expect(out.nextRef).toBe(2);
  });

  it('keeps a number for an element whose descriptor is unchanged', () => {
    const prior = [
      { ref: 0, role: 'link', name: 'Home', kindIndex: 0 },
      { ref: 1, role: 'link', name: 'Reports', kindIndex: 0 },
    ];
    const out = assignStableRefs(prior, 2, [
      el('button', 'Item 0'),
      el('link', 'Home'),
      el('link', 'Reports'),
    ]);
    expect(out.refs).toEqual([2, 0, 1]);
    expect(out.nextRef).toBe(3);
  });

  it('pairs a drifted nth when the role+name group leaves no choice', () => {
    // The first of two "Row" buttons went away, so the survivor is now nth 0
    // rather than nth 1. One element, one unclaimed number: not a guess.
    const prior = [
      { ref: 5, role: 'button', name: 'Row', kindIndex: 1 },
    ];
    expect(assignStableRefs(prior, 9, [el('button', 'Row')]).refs).toEqual([5]);
  });

  it('never hands the same number to two elements', () => {
    const prior = [
      { ref: 3, role: 'button', name: 'Row', kindIndex: 0 },
      { ref: 3, role: 'button', name: 'Row', kindIndex: 0 },
    ];
    const out = assignStableRefs(prior, 4, [el('button', 'Row'), el('button', 'Row')]);
    expect(new Set(out.refs).size).toBe(2);
    expect(out.refs).toEqual([3, 4]);
  });

  it('numbers a new element past every number the history holds, even with a seed behind it', () => {
    const prior = [{ ref: 5, role: 'input', name: 'cc', kindIndex: 0 }];
    const out = assignStableRefs(prior, 1, [el('input', 'cc'), el('input', 'added')]);
    expect(out.refs).toEqual([5, 6]);
    expect(out.nextRef).toBe(7);
  });
});

describe('uniqueDescriptorMatch', () => {
  const descriptor = { role: 'link', name: 'Reports' };

  it('matches one candidate whatever its position', () => {
    const match = uniqueDescriptorMatch(descriptor, [
      el('button', 'Open'),
      el('link', 'Reports'),
    ]);
    expect(match).toEqual(el('link', 'Reports'));
  });

  it('abstains on two look-alikes rather than flipping a coin', () => {
    expect(
      uniqueDescriptorMatch(descriptor, [el('link', 'Reports'), el('link', 'Reports')]),
    ).toBeNull();
  });

  it('abstains when nothing matches', () => {
    expect(uniqueDescriptorMatch(descriptor, [el('link', 'Home')])).toBeNull();
  });
});

describe('per-surface history', () => {
  it('remembers what a ref meant and how far the number space is spent', () => {
    recordRefGeneration('s', 0, [
      { ref: 0, role: 'link', name: 'Home' },
      { ref: 7, role: 'link', name: 'Reports' },
    ]);
    expect(describeRetiredRef('s', 7)).toEqual({
      ref: 7,
      role: 'link',
      name: 'Reports',
      kindIndex: 0,
    });
    expect(nextRefFor('s', 0)).toBe(8);
    expect(describeRetiredRef('s', 99)).toBeNull();
    expect(describeRetiredRef('other', 7)).toBeNull();
  });

  it(`keeps only the last ${DESCRIPTOR_GENERATIONS} generations`, () => {
    for (let g = 0; g <= DESCRIPTOR_GENERATIONS; g++) {
      recordRefGeneration('s', 0, [{ ref: g, role: 'button', name: `Gen ${g}` }]);
    }
    // The oldest generation aged out; every later one is still answerable.
    expect(describeRetiredRef('s', 0)).toBeNull();
    for (let g = 1; g <= DESCRIPTOR_GENERATIONS; g++) {
      expect(describeRetiredRef('s', g)?.name).toBe(`Gen ${g}`);
    }
    expect(priorRefDescriptors('s', 0)).toHaveLength(DESCRIPTOR_GENERATIONS);
  });

  // Frame refs on the RPC lane: spent, but never offered for stable reuse, so
  // the top document can never take a number a frame element had.
  it('spends numbers without remembering them as descriptors', () => {
    recordRefGeneration('s', 0, [{ ref: 3, role: 'button', name: 'Pay' }]);
    reserveRefs('s', 0, 40);
    expect(nextRefFor('s', 0)).toBe(40);
    expect(priorRefDescriptors('s', 0).map((d) => d.ref)).toEqual([3]);
    reserveRefs('s', 0, 10);
    expect(nextRefFor('s', 0)).toBe(40);
  });

  it('answers with the newest generation that carried a ref', () => {
    recordRefGeneration('s', 0, [{ ref: 1, role: 'button', name: 'Old' }]);
    recordRefGeneration('s', 0, [{ ref: 1, role: 'button', name: 'New' }]);
    expect(describeRetiredRef('s', 1)?.name).toBe('New');
  });
});

describe('the recovery note', () => {
  it('is worded once, for both lanes', () => {
    expect(recoveredRefNote(2)).toBe(
      'note=ref 2 was from an earlier snapshot; resolved to the same element',
    );
    expect(recoveredRefNote(2, 'smartRef')).toBe(
      'note=smartRef 2 was from an earlier snapshot; resolved to the same element',
    );
  });
});
