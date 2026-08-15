import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createAtlasModel } from '../atlasCoherenceModel';

/**
 * Invariant tests for the shared WebGL glyph-atlas coherence model.
 * The model is wmux-owned test code that states the algorithm before
 * anyone patches @xterm/addon-webgl. Production still lives in the addon.
 *
 * I1 — clearTexture is total (constructor shape + empty caches)
 * I2 — pages never exceed the sampler budget (evict-all on overflow)
 * I3 — every observer sees a wipe via a monotonic generation
 */

describe('atlas coherence model', () => {
  it('I1: clearTexture empties every page and both caches, not just page 0', () => {
    const atlas = createAtlasModel(4);
    // Force packing onto a non-zero page: fill page 0, then land on the tail.
    atlas.rasterize('fill-page-0', /*w*/ 64, /*h*/ 64);
    const { page } = atlas.rasterize('tail-only', /*w*/ 8, /*h*/ 8);
    expect(page).toBeGreaterThan(0);
    expect(atlas.pageCount).toBeGreaterThan(1);
    // Then:
    atlas.clearTexture();
    expect(atlas.pageCount).toBe(1);
    expect(atlas.cacheSize).toBe(0);
    atlas.clearTexture(); // second call must stay a no-op, not throw
    expect(atlas.pageCount).toBe(1);
  });

  it('I2: allocating past maxPages never yields page >= maxPages', () => {
    const max = 4;
    const atlas = createAtlasModel(max);
    for (let i = 0; i < 200; i++) atlas.rasterize(`g${i}`, 64, 64);
    expect(atlas.pageCount).toBeLessThanOrEqual(max);
  });

  it('I1: a merged page counts as occupied even with its cursor at the origin', () => {
    // The page a merge produces holds every glyph it absorbed while its
    // packing cursor is untouched. Upstream probed the cursor alone, so it
    // read exactly this page as empty and skipped the clear. Occupancy has to
    // be multi-axis or the clear silently does nothing.
    const atlas = createAtlasModel(8);
    for (let i = 0; i < 5; i++) atlas.rasterize(`g${i}`, 64, 64);
    expect(atlas.pageCount).toBeGreaterThan(4);

    expect(atlas.mergePages(4)).toBe(true);
    const afterMerge = atlas.pageCount;

    atlas.clearTexture();
    expect(atlas.pageCount).toBeLessThan(afterMerge);
    expect(atlas.pageCount).toBe(1);
    expect(atlas.cacheSize).toBe(0);
  });

  it('I1: the no-op branch still empties the caches, and does not bump', () => {
    // A sentinel (empty-glyph) entry occupies no page, so a shape probe cannot
    // see it — it would otherwise survive a clear. Nothing an observer holds
    // has moved though, so this must NOT invalidate anyone.
    const atlas = createAtlasModel(4);
    atlas.rasterize('x', 8, 8);
    atlas.clearTexture();
    const generationAfterWipe = atlas.generation;
    expect(atlas.cacheSize).toBe(0);

    // Constructor shape now. Put a cache entry back without occupying a page.
    const sentinel = atlas.rasterize('sentinel', 0, 0);
    expect(sentinel.page).toBe(0);

    atlas.clearTexture();
    expect(atlas.cacheSize).toBe(0);
    expect(atlas.generation).toBe(generationAfterWipe);
  });

  it('I3: a merge invalidates every observer, not just a wipe', () => {
    // A merge rewrites page indices, so it has to advance the generation for
    // the same reason a wipe does. atlasGuard leans on this: it treats an
    // advance as "the atlas already rebuilt its owners" and skips its own
    // repair, which is only sound if a merge really does advance it.
    const atlas = createAtlasModel(8);
    for (let i = 0; i < 5; i++) atlas.rasterize(`g${i}`, 64, 64);
    const before = atlas.generation;
    expect(atlas.mergePages(4)).toBe(true);
    expect(atlas.generation).toBeGreaterThan(before);
  });

  it('I3: two independent observers each see the invalidation exactly once', () => {
    // Mirrors GlyphRenderer.beginFrame: every renderer keeps its OWN last-seen
    // generation, so no renderer can consume another's signal — the failure
    // mode of the shared one-shot boolean this replaced. Reading one counter
    // into two variables, as this test used to, asserts nothing of the sort.
    const atlas = createAtlasModel(8);
    const observer = () => {
      let lastSeen = -1;
      return () => {
        const needsRebuild = lastSeen !== atlas.generation;
        lastSeen = atlas.generation;
        return needsRebuild;
      };
    };
    const a = observer();
    const b = observer();

    // First frame: neither has synced yet.
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    // Steady state: no invalidation, no rebuilds.
    expect(a()).toBe(false);
    expect(b()).toBe(false);

    atlas.rasterize('x', 8, 8);
    atlas.clearTexture();

    // A sees it. B must STILL see it — A did not consume the signal.
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    // And exactly once each.
    expect(a()).toBe(false);
    expect(b()).toBe(false);
  });

  it('installed addon-webgl 0.19.0 still has the I1/I3 patch', () => {
    const pkg = JSON.parse(
      readFileSync('node_modules/@xterm/addon-webgl/package.json', 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('0.19.0');
    const src = readFileSync(
      'node_modules/@xterm/addon-webgl/src/TextureAtlas.ts',
      'utf8',
    );
    expect(src).toContain('I1 — clearTexture is total');
    expect(src).toContain('clearModelGeneration');
  });
});
