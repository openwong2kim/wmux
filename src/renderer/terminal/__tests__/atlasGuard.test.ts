import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearAtlasTexture,
  createAtlasGuard,
  detectMerge,
  clearRenderModel,
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
  /** Set true to mirror the field behaviour where clearTexture does NOT take
   *  effect (upstream early-returns unless _pages[0] is idle), so PREVENT
   *  re-fires on every tick instead of being gated by the anti-thrash rule. */
  clearIsNoop = false;
  /** clearTexture calls made by the guard's own pool wipe. Kept separate from
   *  `paneClears` so a test can still say "the guard rebuilt N times" — the
   *  per-pane model clear reaches the same upstream method. */
  clearTexture(): void {
    this.clearCalls++;
    this.applyClear();
  }
  /** clearTexture reached through a pane's `addon.clearTextureAtlas()`. */
  paneClears = 0;
  clearTextureFromPane(): void {
    this.paneClears++;
    this.applyClear();
  }
  private applyClear(): void {
    if (this.clearIsNoop) return;
    // Faithful to upstream: it decides "already clean, nothing to do" by
    // probing ONLY page 0, then empties every page IN PLACE (count unchanged).
    if (this.pages.length > 0 && this.pages[0].currentRow.x === 0 && this.pages[0].currentRow.y === 0) {
      this.skippedClears++;
      return;
    }
    this.effectiveClears++;
    for (const p of this.pages) p.currentRow = { x: 0, y: 0 };
  }
  /** clearTexture calls that hit upstream's page-0 short-circuit. */
  skippedClears = 0;
  /** clearTexture calls that actually emptied the pool. */
  effectiveClears = 0;
  /** How the real pool grows: APPEND, every existing page object preserved. */
  growBy(n: number): void {
    for (let i = 0; i < n; i++) this.pages.push({ currentRow: { x: 0, y: 1 } });
  }
  /** Upstream's public page-removal event, fired from _deletePage. */
  private removalListeners: Array<(canvas: unknown) => void> = [];
  onRemoveTextureAtlasCanvas(listener: (canvas: unknown) => void): { dispose(): void } {
    this.removalListeners.push(listener);
    return { dispose: () => { this.removalListeners = []; } };
  }
  private fireRemoval(times: number): void {
    for (let i = 0; i < times; i++) for (const l of this.removalListeners) l({});
  }
  /** A merge that consumes only pages appended since the last poll: the tail
   *  grows, those new pages are merged away, and the pool regrows. Every index
   *  the previous poll saw is untouched, so no polled signal can see it. */
  mergeTailOnly(added: number, merged = 4): void {
    this.growBy(added);
    this.pages.splice(this.pages.length - merged, merged);
    this.fireRemoval(merged);
    this.pages.push({ currentRow: { x: 0, y: 1 } });
    this.pages.push({ currentRow: { x: 0, y: 1 } });
  }
  /** Models addon-webgl's `_createNewPage` merge path exactly: the 4 selected
   *  pages are DELETED and TWO are appended — the merged page, then the fresh
   *  page the call was invoked for (that trailing push is unconditional). Net
   *  -2, so only 2 reallocations are needed to hide the merge from a counter. */
  mergePages(count = 4): void {
    this.pages.splice(0, count);
    this.pages.push({ currentRow: { x: 0, y: 1 } }); // merged page
    this.pages.push({ currentRow: { x: 0, y: 1 } }); // the page the caller wanted
  }
  /** Put the pool in the observed field state: page 0 idle (refill resumed from
   *  the tail after an earlier clear) while a later page holds glyphs. That is
   *  the shape that makes upstream's probe short-circuit forever. */
  lockOutClear(): void {
    for (const p of this.pages) p.currentRow = { x: 0, y: 0 };
    this.pages[this.pages.length - 1].currentRow = { x: 78, y: 480 };
  }
  anyPageInUse(): boolean {
    return this.pages.some((p) => p.currentRow.x > 0 || p.currentRow.y > 0);
  }
  pagesInUse(): number {
    return this.pages.filter((p) => p.currentRow.x > 0 || p.currentRow.y > 0).length;
  }
  /** What a pane's refresh() actually does to the pool: the re-raster allocates
   *  from `_activePages[length - 1]`, so the LAST page is back in use before the
   *  next poll — however thoroughly the clear emptied things. */
  refillTail(): void {
    if (this.pages.length > 0) this.pages[this.pages.length - 1].currentRow = { x: 17, y: 64 };
  }
  /** Genuinely near a merge — every page occupied EXCEPT page 0, which is the
   *  one upstream's "already clean" probe reads. This is the state where both
   *  defects bite at once: the gate should fire, and the clear must not
   *  short-circuit. */
  occupyAllButFirst(): void {
    for (const p of this.pages) p.currentRow = { x: 12, y: 340 };
    this.pages[0].currentRow = { x: 0, y: 0 };
  }
}

/** The addon surface the guard walks. `clearTextureAtlas` is upstream's public
 *  wrapper and does what WebglRenderer.clearTextureAtlas does: clear the shared
 *  texture, then clear THIS pane's render model + glyph renderer. Omit it
 *  (`withModelClear: false`) to model a reshaped/DOM-renderer addon. */
function addonFor(
  atlas: FakeAtlas | null,
  onModelClear?: () => void,
  withModelClear = true,
): unknown {
  const base: Record<string, unknown> = { _renderer: { _charAtlas: atlas } };
  if (withModelClear) {
    base.clearTextureAtlas = (): void => {
      atlas?.clearTextureFromPane();
      onModelClear?.();
    };
  }
  return base;
}

function makePane(
  atlas: FakeAtlas | null,
  withModelClear = true,
): {
  entry: { getAddon(): unknown; refresh(): void };
  refreshes: () => number;
  modelClears: () => number;
} {
  let count = 0;
  let modelClears = 0;
  return {
    entry: {
      getAddon: () => addonFor(atlas, () => { modelClears++; }, withModelClear),
      refresh: () => { count++; },
    },
    refreshes: () => count,
    modelClears: () => modelClears,
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

  it('does not fire when the pool is long but mostly empty (the observed field state)', () => {
    // 15 pages exist, 1 holds glyphs — measured live while the old gate was
    // firing every poll. Nothing here is close to needing a new page, so a
    // merge is not close either.
    const atlas = new FakeAtlas(15, true);
    atlas.lockOutClear(); // all idle except the tail
    expect(atlas.pagesInUse()).toBe(1);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS * 5);
    expect(atlas.clearCalls).toBe(0);
    expect(pane.refreshes()).toBe(0);
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
    // The blind spot a count-only signal has. A merge deletes 4 pages and
    // appends 2 (the merged page and the fresh one the call wanted), a net -2;
    // under the CJK burst that causes it those 2 are re-allocated well inside
    // one 2s poll, so the count at both observed boundaries is identical and a
    // drop is never seen. Stay far under PREVENT_AT so the only thing that can
    // fire here is CURE.
    const atlas = new FakeAtlas(6, /* lastPageInUse */ false);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS); // baseline: 6 pages
    expect(atlas.clearCalls).toBe(0);

    atlas.mergePages(4); // 6 → 4 (delete 4, add merged + new): net -2
    atlas.growBy(2); // burst refills → 6 again, count unchanged across polls
    expect(atlas.pages.length).toBe(6); // the count says nothing happened…

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1); // …but identity does
    expect(pane.refreshes()).toBe(1);
  });

  it('CURE still detects a merge while PREVENT is firing on every tick', () => {
    // The live failure mode on v3.38.6: upstream clearTexture returns early
    // when _pages[0] is ALREADY idle, so the pool pressure never drops
    // and PREVENT re-fires every poll — 305 consecutive `prevent — pages=14/16`
    // with zero cure. A baseline DROPPED on each fire leaves `prev` undefined
    // on every following tick, so the identity comparison never runs at all,
    // precisely in the state where a merge is most likely. Re-snapshotting
    // instead of dropping keeps CURE observable through a PREVENT storm.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const atlas = new FakeAtlas(PREVENT_AT, true);
      atlas.clearIsNoop = true; // pressure never drops → PREVENT every tick
      // Cooldown off: this test is specifically about surviving a PREVENT
      // storm, so it needs the storm the rate limit exists to damp.
      const guard = createAtlasGuard({ preventCooldownMs: 0 });
      const pane = makePane(atlas);
      guard.register(pane.entry);

      // Only the guard's own verdict lines — a failed clear logs its own
      // warning alongside them, which is not what this test is counting.
      const verdicts = (): string[] =>
        warn.mock.calls.map((c) => String(c[0])).filter((l) => /prevent|cure \(/.test(l));

      vi.advanceTimersByTime(GUARD_POLL_MS * 3);
      expect(verdicts().length).toBe(3);
      expect(verdicts().every((l) => l.includes('prevent'))).toBe(true);

      // A merge runs between two polls; the burst restores the count, so only
      // identity can reveal it — and only if the baseline survived PREVENT.
      const before = atlas.pages.length;
      atlas.mergePages(4);
      atlas.growBy(2);
      expect(atlas.pages.length).toBe(before);

      vi.advanceTimersByTime(GUARD_POLL_MS);
      expect(verdicts().at(-1)).toContain('cure (merge detected: page-identity)');
    } finally {
      warn.mockRestore();
    }
  });

  it('CURE: catches a merge confined to pages appended since the last poll', () => {
    // Raised in review on #790. Baseline [1..6]; the burst appends 4 pages, the
    // merge selects exactly those 4, and the pool regrows. Every index the
    // previous poll saw is untouched and the count only went UP, so neither
    // polled signal can see it — the page-removal event is the only witness.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const atlas = new FakeAtlas(6, /* lastPageInUse */ false);
      const guard = createAtlasGuard();
      const pane = makePane(atlas);
      guard.register(pane.entry);
      vi.advanceTimersByTime(GUARD_POLL_MS); // baseline
      expect(atlas.clearCalls).toBe(0);
      const before = atlas.pages.length;

      atlas.mergeTailOnly(4);
      expect(atlas.pages.length).toBeGreaterThan(before); // count only grew
      // The polled signals are genuinely blind here — that is the point.
      expect(detectMerge([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeNull();

      vi.advanceTimersByTime(GUARD_POLL_MS);
      expect(atlas.clearCalls).toBe(1);
      expect(pane.refreshes()).toBe(1);
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('cure (merge detected: page-removed)');

      // The latch is consumed: one merge yields one cure, not a stuck signal.
      vi.advanceTimersByTime(GUARD_POLL_MS * 3);
      expect(atlas.clearCalls).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the polled signals when upstream exposes no removal event', () => {
    const atlas = new FakeAtlas(6, /* lastPageInUse */ false);
    (atlas as { onRemoveTextureAtlasCanvas?: unknown }).onRemoveTextureAtlasCanvas = undefined;
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);
    vi.advanceTimersByTime(GUARD_POLL_MS);
    atlas.mergePages(4);
    atlas.growBy(2); // count restored — only identity can see this
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.clearCalls).toBe(1);
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

  it('clearAtlasTexture: defeats the page-0 short-circuit that makes clearing a permanent no-op', () => {
    // Field state on v3.38.6: page 0 idle, one late page holding glyphs, count
    // pinned at the cap. Upstream's probe reads page 0, concludes "already
    // clean" and returns — forever.
    const atlas = new FakeAtlas(15, true);
    atlas.lockOutClear();
    expect(atlas.anyPageInUse()).toBe(true);

    // Baseline: calling upstream directly is a no-op in this state.
    atlas.clearTexture();
    expect(atlas.skippedClears).toBe(1);
    expect(atlas.anyPageInUse()).toBe(true); // pressure did NOT drop

    // Through clearAtlasTexture it takes effect and the postcondition holds.
    expect(clearAtlasTexture(atlas)).toBe('cleared');
    expect(atlas.effectiveClears).toBe(1);
    expect(atlas.anyPageInUse()).toBe(false);
    expect(atlas.pages[0].currentRow).toEqual({ x: 0, y: 0 }); // nudge not left behind
  });

  it('clearAtlasTexture: reports already-clean without calling upstream, and unavailable on a reshaped atlas', () => {
    const clean = new FakeAtlas(4, false);
    for (const p of clean.pages) p.currentRow = { x: 0, y: 0 };
    expect(clearAtlasTexture(clean)).toBe('already-clean');
    expect(clean.clearCalls).toBe(0);

    expect(clearAtlasTexture({ pages: [], clearTexture: () => undefined })).toBe('unavailable');
    expect(clearAtlasTexture({ pages: [{ currentRow: { x: 1, y: 0 } }] })).toBe('unavailable');
  });

  it('clearAtlasTexture: rolls the nudge back and reports failure when the clear does not take', () => {
    const atlas = new FakeAtlas(5, true);
    atlas.lockOutClear();
    atlas.clearTexture = () => { /* upstream reshaped into a no-op */ };
    expect(clearAtlasTexture(atlas)).toBe('failed');
    expect(atlas.pages[0].currentRow).toEqual({ x: 0, y: 0 }); // no residue
  });

  it('PREVENT does not re-arm when refresh() puts the tail page straight back in use', () => {
    // Raised in review: making the clear effective is not enough on its own.
    // Every pane's refresh() re-rasters immediately, and allocation resumes
    // from `_activePages[length - 1]`, so the LAST page is in use again before
    // the next poll. A gate that reads the last page therefore re-arms every
    // 2s no matter how well the clear worked — and now each iteration pays for
    // a real atlas wipe plus an all-pane re-raster, which is worse than the
    // no-op loop it replaced. Occupancy is what has to fall, and it does.
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard();
    // Model the real feedback loop: refreshing a pane refills the tail page.
    const pane = {
      getAddon: () => addonFor(atlas),
      refresh: () => { refreshes++; atlas.refillTail(); },
    };
    let refreshes = 0;
    guard.register(pane);

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.effectiveClears).toBe(1);
    expect(atlas.pagesInUse()).toBe(1); // cleared, then the tail came straight back

    // The tail IS in use again — the old gate's condition is satisfied — but
    // occupancy is 1 of 12, so nothing fires.
    vi.advanceTimersByTime(GUARD_POLL_MS * 10);
    expect(atlas.effectiveClears).toBe(1);
    expect(refreshes).toBe(1);
  });

  it('PREVENT stops thrashing once the clear actually empties the pool', () => {
    // Both defects in one state: the pool IS genuinely near a merge (occupancy
    // 14 of 15) so PREVENT must fire, and page 0 is the idle one so upstream's
    // probe would short-circuit the clear. Before, that produced the
    // 4657-events-a-day loop — fire, no-op, pool still full, fire again.
    const atlas = new FakeAtlas(15, true);
    atlas.occupyAllButFirst();
    expect(atlas.pagesInUse()).toBe(14); // occupancy over the threshold
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.effectiveClears).toBe(1); // the short-circuit was defeated…
    expect(atlas.anyPageInUse()).toBe(false); // …and the pressure dropped
    // The only short-circuited call is the pane's own pairing clear, which runs
    // after the wipe and is meant to be a no-op on the (now empty) pool.
    expect(atlas.skippedClears).toBe(atlas.paneClears);

    // …so the anti-thrash gate engages: no further firing while occupancy is low.
    vi.advanceTimersByTime(GUARD_POLL_MS * 5);
    expect(atlas.effectiveClears).toBe(1);
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

  // --- The corruption the rebuild itself was causing (2026-08-05, v3.38.7) ---

  it('every rebuild drops each pane render model, not just the shared texture', () => {
    // Without this, refresh() re-renders rows but skips every cell whose text
    // is unchanged, so each pane keeps vertex UVs pointing into the pool we
    // just emptied — the "scattered wrong Hangul" report.
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard();
    const a = makePane(atlas);
    const b = makePane(atlas);
    guard.register(a.entry);
    guard.register(b.entry);

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.effectiveClears).toBe(1); // pool wiped once, for everyone
    expect(a.modelClears()).toBe(1); // …and every owner re-derives its glyphs
    expect(b.modelClears()).toBe(1);
  });

  it('drops the model on CURE and on recoverNow too, not only on PREVENT', () => {
    const atlas = new FakeAtlas(6, true);
    const guard = createAtlasGuard();
    const pane = makePane(atlas);
    guard.register(pane.entry);

    vi.advanceTimersByTime(GUARD_POLL_MS); // baseline poll, well under PREVENT
    expect(pane.modelClears()).toBe(0);

    atlas.mergePages(4); // a real merge → CURE
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(pane.modelClears()).toBe(1);

    guard.recoverNow('system-resumed');
    expect(pane.modelClears()).toBe(2);
  });

  it('wipes the shared pool BEFORE dropping any model', () => {
    // Reverse that order and a pane repopulates from the doomed atlas, then the
    // wipe invalidates it again — stale on arrival.
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const order: string[] = [];
    const guard = createAtlasGuard();
    const pane = {
      getAddon: () => addonFor(atlas, () => { order.push(`model:${atlas.anyPageInUse()}`); }),
      refresh: () => { order.push('refresh'); },
    };
    guard.register(pane);

    vi.advanceTimersByTime(GUARD_POLL_MS);
    // `false` = the pool was already empty when the model was dropped.
    expect(order).toEqual(['model:false', 'refresh']);
  });

  it('warns, rather than silently half-repairing, when a pane cannot drop its model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const atlas = new FakeAtlas(PREVENT_AT, true);
      const guard = createAtlasGuard();
      const reachable = makePane(atlas);
      const reshaped = makePane(atlas, false); // no clearTextureAtlas on the addon
      guard.register(reachable.entry);
      guard.register(reshaped.entry);

      vi.advanceTimersByTime(GUARD_POLL_MS);
      expect(reachable.modelClears()).toBe(1);
      expect(reshaped.modelClears()).toBe(0);
      expect(
        warn.mock.calls.map((c) => String(c[0])).some((l) => /render model NOT cleared for 1\/2/.test(l)),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('clearRenderModel: reports failure instead of throwing on a reshaped or dead addon', () => {
    expect(clearRenderModel(null)).toBe(false);
    expect(clearRenderModel({})).toBe(false);
    expect(clearRenderModel({ clearTextureAtlas: 'not a function' })).toBe(false);
    expect(clearRenderModel({ clearTextureAtlas: () => { throw new Error('disposed'); } })).toBe(false);
    let called = 0;
    expect(clearRenderModel({ clearTextureAtlas: () => { called++; } })).toBe(true);
    expect(called).toBe(1);
  });

  // --- Anti-thrash: the rebuild is no longer cheap ---

  it('PREVENT is rate-limited while the pool stays saturated', () => {
    // The v3.38.7 field state: `pages=16/16 used` sustained, so the gate re-arms
    // on the very next poll. Nine wipes in 90s, each one now a full re-raster of
    // every pane.
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard({ preventCooldownMs: GUARD_POLL_MS * 5 });
    const pane = {
      getAddon: () => addonFor(atlas),
      // Faithful: the re-raster immediately refills the pool to saturation.
      refresh: () => { for (const p of atlas.pages) p.currentRow = { x: 9, y: 9 }; },
    };
    guard.register(pane);

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.effectiveClears).toBe(1);

    // Saturated again on every following poll, but the cooldown holds it to one.
    vi.advanceTimersByTime(GUARD_POLL_MS * 4);
    expect(atlas.effectiveClears).toBe(1);

    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.effectiveClears).toBe(2);
  });

  it('the cooldown never delays CURE — a real merge is repaired immediately', () => {
    const atlas = new FakeAtlas(PREVENT_AT, true);
    const guard = createAtlasGuard({ preventCooldownMs: GUARD_POLL_MS * 100 });
    const pane = {
      getAddon: () => addonFor(atlas),
      refresh: () => { for (const p of atlas.pages) p.currentRow = { x: 9, y: 9 }; },
    };
    guard.register(pane);

    vi.advanceTimersByTime(GUARD_POLL_MS); // PREVENT fires, cooldown now armed
    expect(atlas.effectiveClears).toBe(1);

    atlas.mergePages(4); // corruption is real now, not speculative
    vi.advanceTimersByTime(GUARD_POLL_MS);
    expect(atlas.effectiveClears).toBe(2);
  });
});
