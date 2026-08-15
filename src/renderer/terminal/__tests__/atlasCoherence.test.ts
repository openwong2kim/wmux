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

  it('I3: two observers both see a wipe', () => {
    const atlas = createAtlasModel(4);
    const a = atlas.generation;
    const b = atlas.generation;
    atlas.rasterize('x', 8, 8);
    atlas.clearTexture();
    expect(atlas.generation).not.toBe(a);
    expect(atlas.generation).not.toBe(b);
  });
});
