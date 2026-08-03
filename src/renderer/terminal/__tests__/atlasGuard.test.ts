import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAtlasGuard,
  detectMerge,
  extractAtlas,
  GUARD_POLL_MS,
  GUARD_MARGIN_PAGES,
  FALLBACK_MAX_PAGES,
} from '../atlasGuard';

// Minimal stand-ins for the addon-webgl internals the guard walks:
// addon._renderer._charAtlas.{pages, clearTexture, constructor.maxAtlasPages}.

class FakeAtlas {
  static maxAtlasPages = 16;
  pages: Array<{ currentRow: { x: number; y: number } }> = [];
  clearCalls = 0;
  constructor(pageCount: number, lastPageInUse = true) {
    this.setPages(pageCount, lastPageInUse);
  }
  setPages(pageCount: number, lastPageInUse: boolean): void {
    this.pages = Array.from({ length: pageCount }, () => ({ currentRow: { x: 0, y: 1 } }));
    if (this.pages.length > 0 && !lastPageInUse) {
      this.pages[this.pages.length - 1].currentRow = { x: 0, y: 0 };
    }
  }
  clearTexture(): void {
    this.clearCalls++;
    // Mirrors the real clearTexture: pages are emptied IN PLACE, count unchanged.
    for (const p of this.pages) p.currentRow = { x: 0, y: 0 };
  }
  /** How the real pool grows: APPEND, every existing page object preserved. */
  growBy(n: number): void {
    for (let i = 0; i < n; i++) this.pages.push({ currentRow: { x: 0, y: 1 } });
  }
  /** Models addon-webgl's _createNewPage merge: `count` pages are deleted and
   *  ONE freshly created page takes their place (net -(count - 1)). */
  mergeFirst(count = 4): void {
    this.pages.splice(0, count, { currentRow: { x: 0, y: 1 } });
  }
}

function addonFor(atlas: FakeAtlas | null): unknown {
  return { _renderer: { _charAtlas: atlas } };
}

function makePane(atlas: FakeAtlas | null): { entry: { getAddon(): unknown; refresh(): void }; refreshes: () => number } {
  let count = 0;
  return {
    entry: { getAddon: () => addonFor(atlas), refresh: () => { count++; } },
    refreshes: () => count,
  };
}

describe('atlasGuard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // 16-page cap → merge trigger 16 → PREVENT at 16 - GUARD_MARGIN_PAGES = 12.
  const PREVENT_AT = 16 - GUARD_MARGIN_PAGES;

  it('extractAtlas degrades to null on missing internals', () => {
    expect(extractAtlas(null)).toBeNull();
    expect(extractAtlas({})).toBeNull();
    expect(extractAtlas({ _renderer: {} })).toBeNull();
    const atlas = new FakeAtlas(1);
    expect(extractAtlas(addonFor(atlas))).toBe(atlas);
  });

  it('PREVENT: clears + refreshes every sharing pane when the pool nears the merge trigger', () => {
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard();
    const a = makePane(atlas);
    const b = makePane(atlas);
    guard.register(a.entry);
    guard.register(b.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1); // shared atlas — cleared once
    expect(a.refreshes()).toBe(1);
    expect(b.refreshes()).toBe(1); // BOTH owners repainted in the same tick
  });

  it('does not fire below the prevention threshold', () => {
    const atlas = new FakeAtlas(PREVENT_AT - 1, true);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS * 3);
    expect(atlas.clearCalls).toBe(0);
    expect(pane.refreshes()).toBe(0);
  });

  it('does not fire when the last page is empty (pool long but not refilled)', () => {
    const atlas = new FakeAtlas(PREVENT_AT + 2, /* lastPageInUse */ false);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS * 3);
    expect(atlas.clearCalls).toBe(0);
  });

  it('anti-thrash: after a PREVENT clear, does not refire until the pool refills end-to-end', () => {
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1);
    // clearTexture emptied the pages in place; count is unchanged but the last
    // page is idle — further ticks must be no-ops.
    vi.advanceTimersByTime(GUARD_POLL_MS * 5);
    expect(atlas.clearCalls).toBe(1);
    // Pressure genuinely rebuilds (last page in use again) → fires again.
    atlas.setPages(PREVENT_AT, true);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(2);
  });

  it('CURE: a page-count drop between polls (merge ran) triggers clear + refresh-all', () => {
    const atlas = new FakeAtlas(6, /* lastPageInUse */ false); // well under threshold
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS); // baseline poll: 6 pages, no action
    expect(atlas.clearCalls).toBe(0);
    atlas.setPages(3, false); // merge deleted pages — count dropped 6 → 3
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1);
    expect(pane.refreshes()).toBe(1);
  });

  it('CURE: catches a merge whose page count has already regrown before the next poll', () => {
    // The blind spot a count-only signal has. A merge is a net -3 (delete 4,
    // add 1); under the CJK burst that causes it, 3+ pages are re-allocated
    // well inside one 2s poll, so the count at both observed boundaries is
    // identical and a drop is never seen. Stay far under PREVENT_AT so the
    // only thing that can fire here is CURE.
    const atlas = new FakeAtlas(6, /* lastPageInUse */ false);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS); // baseline: 6 pages
    expect(atlas.clearCalls).toBe(0);

    atlas.mergeFirst(4); // 6 → 3, four pages destroyed
    atlas.growBy(3); // burst refills → 6 again, count unchanged across polls
    expect(atlas.pages.length).toBe(6); // the count says nothing happened…

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1); // …but identity does
    expect(pane.refreshes()).toBe(1);
  });

  it('does not fire CURE on pure growth (pages appended, none destroyed)', () => {
    const atlas = new FakeAtlas(3, /* lastPageInUse */ false);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    atlas.growBy(2); // 3 → 5, still well under PREVENT_AT
    vi.advanceTimersByTime(GUARD_POLL_MS);
    atlas.growBy(2); // 5 → 7
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(0);
    expect(pane.refreshes()).toBe(0);
  });

  it('detectMerge: identity beats counting, and growth is not a merge', () => {
    expect(detectMerge(undefined, [1, 2, 3])).toBeNull(); // no baseline yet
    expect(detectMerge([1, 2, 3], [1, 2, 3, 4])).toBeNull(); // appended
    expect(detectMerge([1, 2, 3], [1, 2])).toBe('count-drop'); // still shrunk
    // Merge + regrowth: same length, different pages at seen indices.
    expect(detectMerge([1, 2, 3, 4, 5, 6], [7, 5, 6, 8, 9, 10])).toBe('page-identity');
    // Untaggable pool (every tag 0) degrades to length-only, never a false CURE.
    expect(detectMerge([0, 0, 0], [0, 0, 0, 0])).toBeNull();
    expect(detectMerge([0, 0, 0], [0, 0])).toBe('count-drop');
  });

  it('groups panes by atlas identity — an unrelated atlas is untouched', () => {
    const hot = new FakeAtlas(PREVENT_AT, true);
    const cold = new FakeAtlas(2, true);
    const guard = createAtlasGuard();
    const hotPane = makePane(hot);
    const coldPane = makePane(cold);
    guard.register(hotPane.entry);
    guard.register(coldPane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(hot.clearCalls).toBe(1);
    expect(hotPane.refreshes()).toBe(1);
    expect(cold.clearCalls).toBe(0);
    expect(coldPane.refreshes()).toBe(0);
  });

  it('skips panes on the DOM renderer (no addon) without firing', () => {
    const guard = createAtlasGuard();
    const pane = makePane(null);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS * 3);
    expect(pane.refreshes()).toBe(0);
  });

  it('falls back to FALLBACK_MAX_PAGES when maxAtlasPages is unreadable', () => {
    const atlas = new FakeAtlas(FALLBACK_MAX_PAGES - GUARD_MARGIN_PAGES, true);
    // Sever the static: simulate an upstream reshape of the class shape.
    Object.defineProperty(atlas, 'constructor', { value: {} });
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1);
  });

  it('stops polling when the last pane unregisters, resumes on re-register', () => {
    let setCalls = 0;
    let clearCalls = 0;
    const setSpy: typeof setInterval = ((...args: Parameters<typeof setInterval>) => {
      setCalls++;
      return setInterval(...args);
    }) as typeof setInterval;
    const clearSpy: typeof clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
      clearCalls++;
      clearInterval(id);
    }) as typeof clearInterval;
    const guard = createAtlasGuard({ setIntervalFn: setSpy, clearIntervalFn: clearSpy });
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const pane = makePane(atlas);
    const unregister = guard.register(pane.entry);
    expect(setCalls).toBe(1);
    unregister();
    expect(clearCalls).toBe(1);
    vi.advanceTimersByTime(GUARD_POLL_MS * 3);
    expect(atlas.clearCalls).toBe(0); // timer really stopped
    guard.register(pane.entry);
    expect(setCalls).toBe(2);
  });

  it('recoverNow: unconditional clear + refresh-all, even with a healthy-looking pool', () => {
    const atlas = new FakeAtlas(3, true); // far below every poll threshold
    const guard = createAtlasGuard();
    const a = makePane(atlas);
    const b = makePane(atlas);
    guard.register(a.entry);
    guard.register(b.entry);
    guard.recoverNow('system-resumed');
    expect(atlas.clearCalls).toBe(1);
    expect(a.refreshes()).toBe(1);
    expect(b.refreshes()).toBe(1);
    // Baseline reset: the rebuild must not read as a "merge" on the next poll
    // and trigger a second, redundant CURE rebuild.
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1);
  });

  it('recoverNow with no registered panes is a no-op', () => {
    const guard = createAtlasGuard();
    expect(() => guard.recoverNow('visibility')).not.toThrow();
  });

  it('a refresh() that throws does not break the other panes in the group', () => {
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard();
    const broken = { getAddon: () => addonFor(atlas), refresh: () => { throw new Error('disposed'); } };
    const healthy = makePane(atlas);
    guard.register(broken);
    guard.register(healthy.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(healthy.refreshes()).toBe(1);
  });
});
