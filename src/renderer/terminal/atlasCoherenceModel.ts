/**
 * Local shared-atlas model used only by atlasCoherence tests.
 * States the I1–I3 algorithm in wmux-owned code alongside the
 * @xterm/addon-webgl patch. Not used at runtime.
 *
 * Packing is deliberately tiny: fixed PAGE_AREA pages, tail-active
 * placement (page 0 can sit idle while the tail fills). That shape is
 * exactly what a page-0-only clear probe would mishandle.
 *
 * I1 — clearTexture is total: empty both caches, collapse to one fresh page.
 * I2 — never grow past maxPages; on overflow, evict-all (same end state as I1).
 * I3 — bump generation on every wipe AND on every merge, so N observers can
 *      each notice invalidation independently.
 *
 * The model only earns its keep where it MATCHES the patch, so the two places
 * it used to diverge are gone:
 *
 *   - Occupancy is multi-axis. The patch probes `glyphs.length`, both
 *     `currentRow` axes and `fixedRows`; a single "pixels used" counter cannot
 *     express a page that HOLDS GLYPHS while its packing cursor sits at the
 *     origin, which is precisely what a merged page looks like — and precisely
 *     the state a cursor-only probe calls empty.
 *   - `clearTexture`'s no-op branch keys on SHAPE alone and still empties the
 *     caches. The patch has to: a sentinel (empty-glyph) entry occupies no
 *     page, so a shape probe cannot see it, and leaving it behind would let it
 *     survive a clear. Requiring an empty cache to take the no-op branch — as
 *     this model used to — describes the opposite algorithm.
 */

/** Fixed packing capacity per page (pixels). One 64×64 glyph fills a page. */
const PAGE_AREA = 64 * 64;

export interface AtlasModel {
  rasterize(id: string, width: number, height: number): { page: number };
  clearTexture(): void;
  /** A reducing same-size merge: `count` pages out, one merged page in. */
  mergePages(count?: number): boolean;
  readonly generation: number;
  readonly pageCount: number;
  readonly cacheSize: number;
}

interface Page {
  /** Pixels already packed into this page (drives placement, not occupancy). */
  used: number;
  /** Glyphs resident on this page. A merged page has these with no cursor. */
  glyphs: number;
  /** Packing cursor. Both axes, because the upstream probe read both. */
  cursorX: number;
  cursorY: number;
}

function emptyPage(): Page {
  return { used: 0, glyphs: 0, cursorX: 0, cursorY: 0 };
}

/** Mirrors the patch's `_pageIsOccupied` — any axis, not just the cursor. */
function pageIsOccupied(page: Page): boolean {
  return page.glyphs > 0 || page.cursorX !== 0 || page.cursorY !== 0;
}

export function createAtlasModel(maxPages: number): AtlasModel {
  if (maxPages < 1) {
    throw new Error('maxPages must be >= 1');
  }

  let pages: Page[] = [emptyPage()];
  let generation = 0;
  // Two caches mirror the real atlas's single-char / combined-char maps.
  const singleCache = new Map<string, number>();
  const combinedCache = new Map<string, number>();

  function cacheSize(): number {
    return singleCache.size + combinedCache.size;
  }

  /** Mirrors the patch's `_isConstructorShape`: one page, and it is idle. */
  function isConstructorShape(): boolean {
    return pages.length === 1 && !pageIsOccupied(pages[0]);
  }

  /** Full wipe → constructor shape. Always bumps generation. */
  function wipe(): void {
    pages = [emptyPage()];
    singleCache.clear();
    combinedCache.clear();
    generation++;
  }

  function placeOnNewPage(cost: number): number {
    if (pages.length >= maxPages) {
      // Evict-all on overflow: same end state as clearTexture (I2).
      wipe();
      const page = pages[0];
      page.used = Math.min(cost, PAGE_AREA);
      page.glyphs++;
      page.cursorX = page.used;
      return 0;
    }
    const page = emptyPage();
    page.used = Math.min(cost, PAGE_AREA);
    page.glyphs++;
    page.cursorX = page.used;
    pages.push(page);
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

      // An empty glyph (a sentinel) is cached but occupies no page — which is
      // why `clearTexture`'s shape probe cannot see it, and why the no-op
      // branch has to empty the caches anyway.
      if (width * height === 0) {
        singleCache.set(id, pages.length - 1);
        return { page: pages.length - 1 };
      }

      const cost = width * height;
      // Pack onto the active (tail) page — same shape as 0.19 after a clear.
      let page = pages.length - 1;
      if (pages[page].used + cost > PAGE_AREA) {
        page = placeOnNewPage(cost);
      } else {
        const target = pages[page];
        target.used += cost;
        target.glyphs++;
        target.cursorX = target.used;
      }

      // Split entries across both maps so clearTexture must empty both.
      if (singleCache.size <= combinedCache.size) {
        singleCache.set(id, page);
      } else {
        combinedCache.set(id, page);
      }
      return { page };
    },

    mergePages(count = 4): boolean {
      // Only a REDUCING merge, matching the patch: fewer than `count` pages to
      // give up means there is nothing to win, and the caller falls back to a
      // wipe rather than growing past the budget.
      if (pages.length < count + 1) {
        return false;
      }
      const merged = emptyPage();
      // The merged page carries every glyph it absorbed, and its packing
      // cursor is untouched — occupied on the glyph axis ALONE. A cursor-only
      // probe reads this page as empty, which is the whole point of I1.
      for (const page of pages.splice(0, count)) {
        merged.glyphs += page.glyphs;
        merged.used = Math.min(PAGE_AREA, merged.used + page.used);
      }
      pages.push(merged);
      generation++;
      return true;
    },

    clearTexture(): void {
      if (isConstructorShape()) {
        // Sentinel (empty-glyph) entries hold no page, so the shape probe
        // cannot see them — empty the caches even on the no-op path, and do
        // NOT bump: nothing that any observer can be holding has moved.
        singleCache.clear();
        combinedCache.clear();
        return;
      }
      wipe();
    },
  };
}
