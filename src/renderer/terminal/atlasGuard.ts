// Shared-atlas page-merge guard for the "scattered wrong glyph" corruption
// class (reported 2026-08-01; see TODOS.md).
//
// Root cause (verified against @xterm/addon-webgl 0.19 internals): the WebGL
// glyph texture atlas is SHARED across every same-config terminal
// (acquireTextureAtlas keeps a module-level cache with an ownedBy list). The
// atlas caps its page pool at `TextureAtlas.maxAtlasPages =
// min(32, MAX_TEXTURE_IMAGE_UNITS)` — 16 on Apple Silicon. When the pool is
// full, `_createNewPage()` MERGES four pages into one and DELETES the
// originals, rewriting every affected glyph's texturePage index and shifting
// the indices of the pages behind them. Renderers of OTHER panes sharing the
// atlas keep cached vertex data pointing at the old indices and sample the
// wrong page: scattered wrong glyphs, across several panes at once, that
// plain refresh()/resize cannot repair (the stale cache entries survive a
// re-raster). Opening a new pane fixed it only because its mount recreates a
// WebGL addon and rebuilds the shared atlas from scratch.
//
// CJK is the trigger workload: Hangul alone has 11,172 distinct syllables, so
// Korean-heavy sessions mint new glyphs continuously and are the realistic
// way to exhaust 16 pages.
//
// Strategy — keep the buggy merge path from ever executing, and repair
// coherently if it does:
//
//   PREVENT  When a shared atlas's page count approaches the merge trigger
//            (trigger − GUARD_MARGIN_PAGES) AND the last page is actually in
//            use (pool genuinely refilled, not just long), clear the atlas
//            (clearTexture empties every page in place and clears both cache
//            maps) and refresh every pane sharing it in the same tick. That is
//            the coherent all-owners rebuild upstream itself performs on font
//            changes — the #191 hazard was clearing from ONE pane while its
//            siblings kept stale references, which this never does.
//
//   CURE     If a merge slips through anyway (page count DROPPED between two
//            polls — merges delete 4 pages and add 1, growth only ever adds
//            1), do the same clear+refresh-all. Corruption is visible for at
//            most one poll interval instead of indefinitely.
//
// The "last page in use" condition doubles as the anti-thrash gate: right
// after a clear every page is empty, so PREVENT cannot refire until the pool
// genuinely fills end-to-end again.
//
// Internal-field dependency: reaching the atlas needs `addon._renderer
// ._charAtlas` (same accepted trade-off as webglTeardown.ts's `_renderer._gl`)
// — every access is optional-chained, so if upstream reshapes its internals
// the guard degrades to a silent no-op, never a crash.

/** Pages of headroom left when PREVENT fires. The pool grows one page at a
 *  time, so this is also the number of allocations the guard can miss (poll
 *  gap) before the merge actually triggers. */
export const GUARD_MARGIN_PAGES = 4;
/** Poll cadence. Each tick reads two ints per pane — effectively free — and a
 *  2s gap is far shorter than the several-page refill the margin absorbs. */
export const GUARD_POLL_MS = 2_000;
/** Fallback merge trigger when maxAtlasPages is unreadable: matches the
 *  smallest real-world cap (min(32, 16 texture units) on Apple Silicon). */
export const FALLBACK_MAX_PAGES = 16;

/** One registered pane: how to reach its WebGL addon and repaint it. */
export interface AtlasGuardEntry {
  /** The live WebglAddon instance, or null when on the DOM renderer. */
  getAddon(): unknown;
  /** Full-range terminal.refresh for this pane. */
  refresh(): void;
}

export interface AtlasGuardOptions {
  pollMs?: number;
  marginPages?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

interface AtlasLike {
  pages?: ArrayLike<{ currentRow?: { x?: number; y?: number } }>;
  clearTexture?: () => void;
  constructor?: { maxAtlasPages?: number };
}

/** Duck-typed walk to the shared TextureAtlas behind a WebglAddon. Returns
 *  null whenever any internal is missing (DOM renderer, upstream reshape). */
export function extractAtlas(addon: unknown): AtlasLike | null {
  const atlas = (addon as { _renderer?: { _charAtlas?: unknown } } | null | undefined)
    ?._renderer?._charAtlas;
  return atlas ? (atlas as AtlasLike) : null;
}

export interface AtlasGuard {
  /** Register a pane; returns its unregister function. The poll timer runs
   *  only while at least one pane is registered. */
  register(entry: AtlasGuardEntry): () => void;
}

export function createAtlasGuard(options: AtlasGuardOptions = {}): AtlasGuard {
  const {
    pollMs = GUARD_POLL_MS,
    marginPages = GUARD_MARGIN_PAGES,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  const entries = new Set<AtlasGuardEntry>();
  // Page count per atlas at the previous poll — a drop between polls means a
  // merge ran (growth is strictly one page at a time). WeakMap so a released
  // atlas (all owner panes disposed) never leaks an entry.
  const prevPageCount = new WeakMap<object, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    // Group live panes by shared atlas identity so clear+refresh covers every
    // owner in the same tick (the whole point — no pane may keep sampling a
    // rebuilt atlas with stale references).
    const groups = new Map<AtlasLike, AtlasGuardEntry[]>();
    for (const entry of entries) {
      const atlas = extractAtlas(entry.getAddon());
      if (!atlas) continue;
      const group = groups.get(atlas);
      if (group) group.push(entry);
      else groups.set(atlas, [entry]);
    }

    for (const [atlas, group] of groups) {
      const pages = atlas.pages;
      if (!pages || typeof pages.length !== 'number') continue;
      const len = pages.length;
      const prev = prevPageCount.get(atlas as object);
      prevPageCount.set(atlas as object, len);

      const maxPages =
        typeof atlas.constructor?.maxAtlasPages === 'number'
          ? atlas.constructor.maxAtlasPages
          : FALLBACK_MAX_PAGES;
      // Mirror of the addon's own merge trigger: pages.length >= max(4, maxAtlasPages).
      const mergeTrigger = Math.max(4, maxPages);
      const preventAt = Math.max(2, mergeTrigger - marginPages);

      const lastPage = len > 0 ? pages[len - 1] : undefined;
      const lastPageInUse =
        (lastPage?.currentRow?.x ?? 0) > 0 || (lastPage?.currentRow?.y ?? 0) > 0;

      const merged = prev !== undefined && len < prev;
      const nearTrigger = len >= preventAt && lastPageInUse;
      if (!merged && !nearTrigger) continue;

      console.warn(
        `[wmux:atlas-guard] ${merged ? 'cure (merge detected)' : 'prevent'} — pages=${len}/${mergeTrigger}, panes=${group.length}`,
      );
      try {
        atlas.clearTexture?.(); // shared — one call empties it for every owner
      } catch {
        // atlas mid-teardown; refresh below is still harmless
      }
      for (const entry of group) {
        try {
          entry.refresh();
        } catch {
          // pane may be disposing — the next tick simply won't see it
        }
      }
    }
  }

  return {
    register(entry: AtlasGuardEntry): () => void {
      entries.add(entry);
      if (timer === null) timer = setIntervalFn(tick, pollMs);
      return () => {
        entries.delete(entry);
        if (entries.size === 0 && timer !== null) {
          clearIntervalFn(timer);
          timer = null;
        }
      };
    },
  };
}

/** App-wide singleton — panes register in useTerminal's main effect. */
export const atlasGuard = createAtlasGuard();
