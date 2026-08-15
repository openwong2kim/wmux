/**
 * Local shared-atlas model used only by atlasCoherence tests.
 * States the I1–I3 algorithm in wmux-owned code before patching
 * @xterm/addon-webgl. Not used at runtime.
 *
 * Packing is deliberately tiny: fixed PAGE_AREA pages, tail-active
 * placement (page 0 can sit idle while the tail fills). That shape is
 * exactly what a page-0-only clear probe would mishandle.
 *
 * I1 — clearTexture is total: empty both caches, collapse to one fresh page.
 * I2 — never grow past maxPages; on overflow, evict-all (same end state as I1).
 * I3 — bump generation on every wipe (and on merge, if a later model adds one)
 *      so N observers can each notice invalidation independently.
 */

/** Fixed packing capacity per page (pixels). One 64×64 glyph fills a page. */
const PAGE_AREA = 64 * 64;

export interface AtlasModel {
  rasterize(id: string, width: number, height: number): { page: number };
  clearTexture(): void;
  readonly generation: number;
  readonly pageCount: number;
  readonly cacheSize: number;
}

interface Page {
  /** Pixels already packed into this page. */
  used: number;
}

export function createAtlasModel(maxPages: number): AtlasModel {
  if (maxPages < 1) {
    throw new Error('maxPages must be >= 1');
  }

  let pages: Page[] = [{ used: 0 }];
  let generation = 0;
  // Two caches mirror the real atlas's single-char / combined-char maps.
  const singleCache = new Map<string, number>();
  const combinedCache = new Map<string, number>();

  function cacheSize(): number {
    return singleCache.size + combinedCache.size;
  }

  function anyPageInUse(): boolean {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].used > 0) return true;
    }
    return false;
  }

  /** Full wipe → constructor shape. Always bumps generation. */
  function wipe(): void {
    pages = [{ used: 0 }];
    singleCache.clear();
    combinedCache.clear();
    generation++;
  }

  function placeOnNewPage(cost: number): number {
    if (pages.length >= maxPages) {
      // Evict-all on overflow: same end state as clearTexture (I2).
      wipe();
      pages[0].used = Math.min(cost, PAGE_AREA);
      return 0;
    }
    pages.push({ used: Math.min(cost, PAGE_AREA) });
    return pages.length - 1;
  }

  return {
    get generation() {
      return generation;
    },
    get pageCount() {
      return pages.length;
    },
    get cacheSize() {
      return cacheSize();
    },

    rasterize(id: string, width: number, height: number): { page: number } {
      const cached = singleCache.get(id) ?? combinedCache.get(id);
      if (cached !== undefined) {
        return { page: cached };
      }

      const cost = Math.max(1, width * height);
      // Pack onto the active (tail) page — same shape as 0.19 after a clear.
      let page = pages.length - 1;
      if (pages[page].used + cost > PAGE_AREA) {
        page = placeOnNewPage(cost);
      } else {
        pages[page].used += cost;
      }

      // Split entries across both maps so clearTexture must empty both.
      if (singleCache.size <= combinedCache.size) {
        singleCache.set(id, page);
      } else {
        combinedCache.set(id, page);
      }
      return { page };
    },

    clearTexture(): void {
      // Probe ALL pages' occupancy — never page 0 alone (that is the 0.19 bug).
      if (!anyPageInUse() && pages.length === 1 && cacheSize() === 0) {
        return;
      }
      wipe();
    },
  };
}
