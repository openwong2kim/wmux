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
//            (trigger − GUARD_MARGIN_PAGES) AND that many pages are actually
//            OCCUPIED (a long pool of empty pages is nowhere near a merge —
//            see defect 2 below), clear the atlas
//            (clearTexture empties every page in place and clears both cache
//            maps) and refresh every pane sharing it in the same tick. That is
//            the coherent all-owners rebuild upstream itself performs on font
//            changes — the #191 hazard was clearing from ONE pane while its
//            siblings kept stale references, which this never does.
//
//   CURE     If a merge slips through anyway, do the same clear+refresh-all.
//            Corruption is visible for at most one poll interval instead of
//            indefinitely.
//
//            Three signals feed it, strongest first — a page-removal EVENT, a
//            page-count drop, and a page-identity change. Count alone is not
//            enough, and the trigger workload walks straight into its blind
//            spot. Read the real arity off `_createNewPage`: on the merge path
//            it deletes the 4 selected pages, pushes the merged one, and then
//            falls through to push the fresh page it was called for — delete 4,
//            add 2, a net −2. So a count drop is only visible while the pool
//            stays shrunk, and the very output burst that causes the merge
//            re-allocates those 2 pages well inside one 2s poll: the count is
//            back where it started and CURE never fires.
//
//            Page identity closes that gap without replacing the count check —
//            growth only ever APPENDS, so every previously seen index must
//            still hold the SAME page object, and a changed slot means pages
//            were deleted and re-created. Count-drop remains supported, and is
//            the fallback whenever pages cannot carry an identity tag.
//
//            Neither polled signal can see a merge confined to pages BORN AND
//            DESTROYED between two samples (raised in review on #790), so the
//            guard also subscribes to upstream's page-removal event and
//            prefers it: `_deletePage` is only ever reached from the merge
//            path, making it an exact, real-time signal with no sampling gap.
//
// Two independent defects made that repair fire 4657 times in one day and
// achieve nothing. Both are fixed here.
//
//   1. The clear did not clear. Upstream `clearTexture()` short-circuits on a
//      page-0-only "already clean" probe, and page 0 is exactly the page that
//      stays empty once refill resumes from the tail — so it became a permanent
//      no-op. `clearAtlasTexture` below defeats that probe and VERIFIES the
//      postcondition instead of assuming it.
//
//   2. The gate measured the wrong thing. PREVENT asked "is the LAST page in
//      use", but allocation resumes from `_activePages[length - 1]`, so one
//      glyph after a clear re-arms it immediately — there is no anti-thrash
//      property in that condition at all, whether or not the clear works. It
//      now measures OCCUPANCY (`used >= preventAt`), which is what actually
//      predicts a merge: upstream only merges from `_createNewPage`, and a new
//      page is only created when a glyph fits in no existing page. Measured in
//      the field at the moment of a PREVENT storm: 15 pages, 1 in use — every
//      one of those firings was spurious.
//
// Fixing only (1) would have been worse than shipping neither: the no-op loop
// would have become a real full-atlas wipe plus an all-pane re-raster, every
// two seconds, forever.
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
  /** Upstream public event, fired from `_deletePage` — which is only ever
   *  reached from the merge path. An exact, real-time merge signal. */
  onRemoveTextureAtlasCanvas?: (listener: (canvas: unknown) => void) => unknown;
}

/** Monotonic tag that recognises a page ACROSS polls WITHOUT holding a
 *  reference to it. Remembering the page objects themselves would keep every
 *  merged-away atlas canvas alive until the next poll — exactly the memory the
 *  merge just reclaimed. The property is non-enumerable and symbol-keyed, so it
 *  is invisible to anything that does not already hold the symbol. */
const PAGE_TAG = Symbol('wmux.atlasGuard.page');
let nextPageTag = 1;

/** Stable per-page id, minted on first sight. Returns 0 for anything that
 *  cannot carry the tag (frozen page, non-object after an upstream reshape);
 *  0 === 0 compares equal, so an untaggable pool simply degrades to the
 *  length comparison rather than reporting a merge on every poll. */
function pageTag(page: unknown): number {
  if (page === null || (typeof page !== 'object' && typeof page !== 'function')) return 0;
  const existing = (page as Record<symbol, unknown>)[PAGE_TAG];
  if (typeof existing === 'number') return existing;
  const tag = nextPageTag++;
  try {
    Object.defineProperty(page, PAGE_TAG, { value: tag, enumerable: false, configurable: true });
  } catch {
    return 0; // sealed/frozen — degrade to length-only detection
  }
  return tag;
}

/** Why CURE fired, or null when the pool only grew. `page-removed` is the exact
 *  push signal; the other two are the polled fallbacks. Exported for direct
 *  unit testing. */
export type MergeSignal = 'page-removed' | 'count-drop' | 'page-identity';

/**
 * Compare two page-tag snapshots.
 *
 * `count-drop` is the classic signal (the pool was still shrunk when we
 * looked). `page-identity` closes its blind spot for the common case: growth
 * only ever appends, so a changed slot at a previously seen index can only mean
 * pages were deleted and re-created, which stays true after the count regrows.
 * Both remain supported — count-drop is also the fallback when pages cannot
 * carry a tag.
 *
 * Neither can see a merge confined to pages that were BORN AND DESTROYED
 * between two samples: baseline [1..12] can grow with 13-16, merge exactly
 * those four, and regrow, leaving every observed index untouched. That case is
 * unobservable by polling at all, which is why the guard also subscribes to
 * upstream's page-removal event (`page-removed`) and prefers it.
 */
export function detectMerge(prev: number[] | undefined, next: number[]): MergeSignal | null {
  if (!prev) return null;
  if (next.length < prev.length) return 'count-drop';
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return 'page-identity';
  }
  return null;
}

/** Tag every page in the pool, in order. Reading this AFTER a rebuild is what
 *  keeps the next poll honest without blinding it. */
function snapshotTags(atlas: AtlasLike): number[] {
  const pages = atlas.pages;
  if (!pages || typeof pages.length !== 'number') return [];
  const tags: number[] = new Array(pages.length);
  for (let i = 0; i < pages.length; i++) tags[i] = pageTag(pages[i]);
  return tags;
}

/** What clearAtlasTexture actually managed to do. */
export type ClearOutcome = 'cleared' | 'already-clean' | 'unavailable' | 'failed';

/** Just the surface clearAtlasTexture needs. Deliberately NOT `AtlasLike`:
 *  that one carries an optional `constructor` field for the page cap, which
 *  every real object already has as `Function`, so a class instance can never
 *  satisfy it structurally. `AtlasLike` is only ever reached through a cast
 *  inside this module, but a caller — a test, or any future one — cannot. */
export interface ClearableAtlas {
  pages?: ArrayLike<{ currentRow?: { x?: number; y?: number } }>;
  clearTexture?: () => void;
}

/** True when a page holds glyphs (its packing cursor has moved off the origin). */
function pageInUse(page: { currentRow?: { x?: number; y?: number } } | undefined): boolean {
  return (page?.currentRow?.x ?? 0) > 0 || (page?.currentRow?.y ?? 0) > 0;
}

/**
 * Empty the shared atlas — and make sure it actually happened.
 *
 * Upstream `clearTexture()` decides "already clean, nothing to do" by probing
 * ONE page:
 *
 *   clearTexture() { if (this._pages[0].currentRow.x === 0 &&
 *                        this._pages[0].currentRow.y === 0) return; ... }
 *
 * That probe is only sound if page 0 fills first. It does not: after a clear,
 * glyph packing resumes from `_activePages[_activePages.length - 1]` — the
 * TAIL. So page 0 stays empty while the later pages refill, the probe reads
 * "already clean" forever, and clearTexture becomes a PERMANENT no-op for that
 * atlas. Measured on v3.38.6 (2026-08-04): page 0 idle at every 2s sample over
 * 12s, only 1 of 15 pages in use, count pinned at 15, and the guard's PREVENT
 * path firing on every poll with no effect — 4657 guard events in one day
 * against 6 cures.
 *
 * The fix has to live here: @xterm/addon-webgl is a dependency we do not patch.
 * When some page is in use but page 0 is not, move page 0's cursor off the
 * origin so the probe cannot short-circuit, then let upstream do the real work
 * (it also clears the two glyph cache maps, which we must not do by hand — a
 * cleared page with a live cache entry pointing into it is the #191 hazard).
 *
 * The postcondition is then VERIFIED rather than assumed: every page must come
 * back idle. If it does not, the nudge is rolled back and the caller is told,
 * instead of the guard quietly looping forever like it has been.
 */
export function clearAtlasTexture(atlas: ClearableAtlas): ClearOutcome {
  const pages = atlas.pages;
  if (!pages || typeof pages.length !== 'number' || pages.length === 0) return 'unavailable';
  if (typeof atlas.clearTexture !== 'function') return 'unavailable';

  let anyInUse = false;
  for (let i = 0; i < pages.length; i++) {
    if (pageInUse(pages[i])) { anyInUse = true; break; }
  }
  if (!anyInUse) return 'already-clean';

  const first = pages[0];
  let nudged = false;
  if (!pageInUse(first) && first?.currentRow) {
    try {
      first.currentRow.x = 1;
      nudged = true;
    } catch {
      // frozen row — fall through and let upstream decide; worst case is the
      // no-op we already have today.
    }
  }
  const rollback = (): void => {
    if (nudged && first?.currentRow?.x === 1) {
      try { first.currentRow.x = 0; } catch { /* nothing else we can do */ }
    }
  };

  try {
    atlas.clearTexture();
  } catch {
    rollback();
    return 'failed';
  }
  for (let i = 0; i < pages.length; i++) {
    if (pageInUse(pages[i])) { rollback(); return 'failed'; }
  }
  return 'cleared';
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
  /**
   * Unconditional coherent rebuild: clear every shared atlas and refresh all
   * of its owner panes in the same tick. For recovery boundaries the poll
   * cannot see — sleep→wake can trash atlas TEXTURE CONTENT while the page
   * structures the poll reads stay perfectly consistent, so PREVENT/CURE
   * never fire. (Boundary-driven rebuild pattern borrowed from Orca's
   * wake-recovery design — idea only, no code:
   * github.com/stablyai/orca pane-webgl-renderer.ts.)
   */
  recoverNow(reason: string): void;
}

export function createAtlasGuard(options: AtlasGuardOptions = {}): AtlasGuard {
  const {
    pollMs = GUARD_POLL_MS,
    marginPages = GUARD_MARGIN_PAGES,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  const entries = new Set<AtlasGuardEntry>();
  // Page-tag snapshot per atlas at the previous poll. Tags (not page objects)
  // so a merged-away page is free to be collected immediately. WeakMap so a
  // released atlas (all owner panes disposed) never leaks an entry.
  const prevPageTags = new WeakMap<object, number[]>();
  // Per-atlas latch fed by upstream's page-removal event. Subscribed once, on
  // first sight; never unsubscribed, because the listener cannot outlive the
  // emitter it lives on (both die with the atlas).
  const removalLatch = new WeakMap<object, { fired: boolean }>();
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Latch for this atlas, subscribing on first sight. null when upstream does
   *  not expose the event — the polled signals then carry detection alone. */
  function watchRemovals(atlas: AtlasLike): { fired: boolean } | null {
    const key = atlas as object;
    const existing = removalLatch.get(key);
    if (existing) return existing;
    if (typeof atlas.onRemoveTextureAtlasCanvas !== 'function') return null;
    const latch = { fired: false };
    try {
      atlas.onRemoveTextureAtlasCanvas(() => { latch.fired = true; });
    } catch {
      return null; // reshaped upstream — degrade to polling
    }
    removalLatch.set(key, latch);
    return latch;
  }

  // Group live panes by shared atlas identity so clear+refresh covers every
  // owner in the same tick (the whole point — no pane may keep sampling a
  // rebuilt atlas with stale references).
  function groupByAtlas(): Map<AtlasLike, AtlasGuardEntry[]> {
    const groups = new Map<AtlasLike, AtlasGuardEntry[]>();
    for (const entry of entries) {
      const atlas = extractAtlas(entry.getAddon());
      if (!atlas) continue;
      const group = groups.get(atlas);
      if (group) group.push(entry);
      else groups.set(atlas, [entry]);
    }
    return groups;
  }

  // The coherent rebuild both PREVENT/CURE and recoverNow perform: empty the
  // shared atlas, then re-raster every owner pane in the same tick.
  function rebuildGroup(atlas: AtlasLike, group: AtlasGuardEntry[]): string {
    // shared — one call empties it for every owner. Goes through
    // clearAtlasTexture so upstream's page-0-only "already clean" probe cannot
    // silently turn the clear into a no-op (see that function).
    const outcome = clearAtlasTexture(atlas);
    if (outcome === 'failed') {
      console.warn('[wmux:atlas-guard] clear did not take effect — pool pressure will not drop');
    }
    for (const entry of group) {
      try {
        entry.refresh();
      } catch {
        // pane may be disposing — the next tick simply won't see it
      }
    }
    return outcome;
  }

  function tick(): void {
    const groups = groupByAtlas();

    for (const [atlas, group] of groups) {
      const pages = atlas.pages;
      if (!pages || typeof pages.length !== 'number') continue;
      const len = pages.length;
      const tags = snapshotTags(atlas);
      const prev = prevPageTags.get(atlas as object);
      prevPageTags.set(atlas as object, tags);

      const maxPages =
        typeof atlas.constructor?.maxAtlasPages === 'number'
          ? atlas.constructor.maxAtlasPages
          : FALLBACK_MAX_PAGES;
      // Mirror of the addon's own merge trigger: pages.length >= max(4, maxAtlasPages).
      const mergeTrigger = Math.max(4, maxPages);
      const preventAt = Math.max(2, mergeTrigger - marginPages);

      // Occupancy, not "has the last page been touched". Upstream only merges
      // from `_createNewPage`, and a new page is only created when a glyph fits
      // in NO existing page — i.e. when the pages in use are full. A long pool
      // of mostly-empty pages is not close to a merge at all.
      //
      // The old proxy read the last page alone, which is exactly the page that
      // refills first: allocation resumes from `_activePages[length - 1]`, so a
      // single glyph after a clear put it back "in use" and PREVENT re-armed on
      // the very next poll. In the field that fired 4657 times in one day at an
      // occupancy of 1 page out of 15 — every one of them spurious, and every
      // one now paying for a full atlas wipe and an all-pane re-raster.
      let used = 0;
      for (let i = 0; i < len; i++) if (pageInUse(pages[i])) used++;

      // Exact push signal first: a page removal can only come from the merge
      // path, and it sees merges that happened entirely between two samples.
      // Consume the latch either way so one merge fires one cure.
      const latch = watchRemovals(atlas);
      const removed = latch?.fired ?? false;
      if (latch) latch.fired = false;
      const mergeSignal: MergeSignal | null = removed ? 'page-removed' : detectMerge(prev, tags);
      const nearTrigger = len >= preventAt && used >= preventAt;
      if (!mergeSignal && !nearTrigger) continue;

      const outcome = rebuildGroup(atlas, group);
      console.warn(
        `[wmux:atlas-guard] ${mergeSignal ? `cure (merge detected: ${mergeSignal})` : 'prevent'}` +
          ` — pages=${used}/${len} used, cap=${mergeTrigger}, panes=${group.length}, clear=${outcome}`,
      );
      // Re-baseline from the POST-rebuild pool. The rebuild is itself a
      // structural change, so a snapshot taken before it could read as a merge
      // on the next poll and fire a second, redundant rebuild.
      //
      // Re-snapshot, never drop. Dropping the baseline leaves `prev` undefined
      // on the next poll, which blinds detectMerge for that whole interval —
      // and PREVENT is not a one-off: in the field it repeats on EVERY tick
      // (observed: 305 consecutive `prevent — pages=14/16`, zero cure). With a
      // dropped baseline that means `prev` is undefined on every tick and the
      // identity comparison never runs at all, exactly when it is needed most.
      prevPageTags.set(atlas as object, snapshotTags(atlas));
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
    recoverNow(reason: string): void {
      const groups = groupByAtlas();
      if (groups.size === 0) return;
      console.warn(`[wmux:atlas-guard] recover (${reason}) — atlases=${groups.size}`);
      for (const [atlas, group] of groups) {
        rebuildGroup(atlas, group);
        // Re-baseline from the post-rebuild pool for the same reason the poll
        // does: a stale snapshot would read the rebuild as a "merge" and fire a
        // redundant one next tick, while dropping it would blind the next poll.
        prevPageTags.set(atlas as object, snapshotTags(atlas));
      }
    },
  };
}

/** App-wide singleton — panes register in useTerminal's main effect. */
export const atlasGuard = createAtlasGuard();
