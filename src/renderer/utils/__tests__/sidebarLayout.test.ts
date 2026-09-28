import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resolveSidebarSortMode,
  sortModeMigratedToAttention,
  ORPHAN_GROUP_KEY,
  pruneTaskGroupExpanded,
  movePinned,
  pinnedFirst,
  togglePinned,
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
  it('keeps a mode the user explicitly chose, Manual included', () => {
    expect(resolveSidebarSortMode({ sidebarSortMode: 'manual', sidebarSortModeChosen: true })).toBe('manual');
    expect(resolveSidebarSortMode({ sidebarSortMode: 'attention', sidebarSortModeChosen: true })).toBe('attention');
  });

  it('keeps Recent activity, which was only ever reachable by choosing it', () => {
    expect(resolveSidebarSortMode({ sidebarSortMode: 'recent' })).toBe('recent');
  });

  it('migrates everything else to Attention (2026-09-25 default)', () => {
    expect(resolveSidebarSortMode({ sidebarAttentionFirst: true })).toBe('attention');
    expect(resolveSidebarSortMode({ sidebarAttentionFirst: false })).toBe('attention');
    expect(resolveSidebarSortMode({})).toBe('attention');
    expect(resolveSidebarSortMode({ sidebarSortMode: 'manual' })).toBe('attention');
    expect(resolveSidebarSortMode({ sidebarSortMode: 'alphabetical', sidebarSortModeChosen: true })).toBe('attention');
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
    expect(store.getState().sidebarSortModeChosen).toBe(false);
    store.getState().setSidebarSortMode('attention');
    expect(store.getState().sidebarAttentionFirst).toBe(true);
    store.getState().setSidebarSortMode('recent');
    expect(store.getState().sidebarAttentionFirst).toBe(false);
    store.getState().setSidebarAttentionFirst(true);
    expect(store.getState().sidebarSortMode).toBe('attention');
    // Review #10 — the legacy setter records an explicit choice too.
    expect(store.getState().sidebarSortModeChosen).toBe(true);
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

// Review #10 — who gets the one-time "now sorts by attention" notice.
describe('sortModeMigratedToAttention', () => {
  it('is true for a list that was showing Manual without a recorded choice', () => {
    expect(sortModeMigratedToAttention({ sidebarSortMode: 'manual' })).toBe(true);
    expect(sortModeMigratedToAttention({ sidebarAttentionFirst: false })).toBe(true);
  });
  it('is false for a chosen Manual, an attention list, and Recent activity', () => {
    expect(sortModeMigratedToAttention({ sidebarSortMode: 'manual', sidebarSortModeChosen: true })).toBe(false);
    expect(sortModeMigratedToAttention({ sidebarAttentionFirst: true })).toBe(false);
    expect(sortModeMigratedToAttention({ sidebarSortMode: 'attention' })).toBe(false);
    expect(sortModeMigratedToAttention({ sidebarSortMode: 'recent' })).toBe(false);
  });
});

describe('pinned to top (2026-09-26)', () => {
  const ws = (...ids: string[]) => ids.map((id) => ({ id }));
  const ids = (list: { id: string }[]) => list.map((w) => w.id);

  it('pinnedFirst keeps each side in its order', () => {
    expect(ids(pinnedFirst(ws('a', 'p1', 'b', 'p2'), new Set(['p2', 'p1'])))).toEqual(['p1', 'p2', 'a', 'b']);
  });

  it('pinning moves the row to the end of the group; unpinning to the top of the rest', () => {
    const pinned = togglePinned(ws('p1', 'a', 'b', 'c'), ['p1'], 'c');
    expect(pinned && ids(pinned.items)).toEqual(['p1', 'c', 'a', 'b']);
    expect(pinned?.pinnedIds).toEqual(['p1', 'c']);
    const unpinned = togglePinned(pinned!.items, pinned!.pinnedIds, 'p1');
    expect(unpinned && ids(unpinned.items)).toEqual(['c', 'p1', 'a', 'b']);
    expect(unpinned?.pinnedIds).toEqual(['c']);
    expect(togglePinned(ws('a'), [], 'missing')).toBeNull();
  });

  it('a drop takes the target row\'s pin state, so crossing the boundary pins or unpins', () => {
    // Drag c (unpinned) above p2 (pinned) → pinned, between p1 and p2.
    const pin = movePinned(ws('p1', 'p2', 'a', 'c'), ['p1', 'p2'], 3, 1, true);
    expect(pin && ids(pin.items)).toEqual(['p1', 'c', 'p2', 'a']);
    expect(pin?.pinnedIds).toEqual(['p1', 'p2', 'c']);
    // Drag p2 (last pinned) just above a (first unpinned): same index, state flips.
    const unpin = movePinned(ws('p1', 'p2', 'a'), ['p1', 'p2'], 1, 1, false);
    expect(unpin && ids(unpin.items)).toEqual(['p1', 'p2', 'a']);
    expect(unpin?.pinnedIds).toEqual(['p1']);
    // No move and no state change is a no-op.
    expect(movePinned(ws('p1', 'a'), ['p1'], 1, 1, false)).toBeNull();
    // Out of range is refused.
    expect(movePinned(ws('a'), [], 0, 3)).toBeNull();
  });
});
