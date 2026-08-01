import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAtlasGuard,
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
