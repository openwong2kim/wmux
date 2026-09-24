import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resolveSidebarSortMode,
  ORPHAN_GROUP_KEY,
  pruneTaskGroupExpanded,
} from '../sidebarLayout';
import { createUISlice, type UISlice } from '../../stores/slices/uiSlice';

describe('clampSidebarWidth (#1481)', () => {
  it('keeps a width inside the drag range and rounds it', () => {
    expect(clampSidebarWidth(300.4)).toBe(300);
  });

  it('pins a width outside the range to the nearest bound', () => {
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('falls back to the default for anything that is not a finite number', () => {
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth('320')).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('resolveSidebarSortMode (#1481)', () => {
  it('reads a known mode as-is', () => {
    expect(resolveSidebarSortMode({ sidebarSortMode: 'recent' })).toBe('recent');
  });

  it('maps a pre-mode session with the attention flag onto the attention mode', () => {
    expect(resolveSidebarSortMode({ sidebarAttentionFirst: true })).toBe('attention');
    expect(resolveSidebarSortMode({})).toBe('manual');
  });

  it('ignores an unknown mode string', () => {
    expect(resolveSidebarSortMode({ sidebarSortMode: 'alphabetical', sidebarAttentionFirst: false })).toBe('manual');
  });
});

describe('uiSlice sidebar width + sort mode (#1481)', () => {
  const makeStore = () =>
    create<UISlice>()(
      immer((...args) => ({
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createUISlice(...args),
      })),
    );

  it('defaults to 264px and clamps what the drag handle sets', () => {
    const store = makeStore();
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    store.getState().setSidebarWidth(1000);
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    // The handle's double-click reset is a plain set to the default.
    store.getState().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('keeps the attention flag in lockstep with the sort mode', () => {
    const store = makeStore();
    store.getState().setSidebarSortMode('attention');
    expect(store.getState().sidebarAttentionFirst).toBe(true);
    store.getState().setSidebarSortMode('recent');
    expect(store.getState().sidebarAttentionFirst).toBe(false);
    store.getState().setSidebarAttentionFirst(true);
    expect(store.getState().sidebarSortMode).toBe('attention');
  });
});

// #1481 review B10 — expansion memory is pruned to open owners.

describe('pruneTaskGroupExpanded', () => {
  it('keeps open owners and the closed-owner key, drops the rest and bad values', () => {
    expect(pruneTaskGroupExpanded({ a: true, gone: false, [ORPHAN_GROUP_KEY]: false, b: 'yes' }, new Set(['a', 'b'])))
      .toEqual({ a: true, [ORPHAN_GROUP_KEY]: false });
    expect(pruneTaskGroupExpanded(undefined, new Set())).toEqual({});
  });
});
