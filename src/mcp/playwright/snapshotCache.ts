import { getConnectionScope } from '../connectionScope';

// ---------------------------------------------------------------------------
// Per-surface snapshot baselines for browser_snapshot's auto-diff mode.
//
// A baseline is the last full snapshot text a caller produced for a surface;
// the next snapshot with matching attributes returns a diff against it instead
// of the full tree. Stored per connection (broker) with a module-global
// fallback (single-child) — the elementCache idiom in dom-intelligence.ts —
// so two agents on the same surface never diff against each other's baseline.
// ---------------------------------------------------------------------------

export interface SnapshotBaseline {
  text: string;
  /** Attribute key: a diff is only valid against a baseline produced with the
   *  same format/selector/filter — mismatches replace, never diff. */
  attrs: string;
  /** Page URL at capture time. Diffing across different URLs is never valid:
   *  a missed navigation event (destructive drain won by another consumer,
   *  in-surface tab switch, drain response lost) must degrade to a full
   *  snapshot, not a diff against a page that no longer exists (3-model
   *  review consensus). */
  url?: string;
  ts: number;
}

// Bounds: a handful of surfaces per agent is the realistic ceiling; TTL is a
// backstop against diffing a snapshot from a long-abandoned page state when a
// navigation event was missed (e.g. main lacked browser.lifecycle.get).
// 16, not 8: entries are per surface AND per tool now, so the old cap would
// have halved the surfaces a diff can survive across.
const MAX_BASELINES = 16;
const BASELINE_TTL_MS = 5 * 60 * 1000;

let moduleBaselines: Map<string, SnapshotBaseline> | undefined;

function getStore(): Map<string, SnapshotBaseline> {
  const scope = getConnectionScope();
  if (scope) {
    const existing = scope.snapshotCache as Map<string, SnapshotBaseline> | undefined;
    if (existing) return existing;
    const fresh = new Map<string, SnapshotBaseline>();
    scope.snapshotCache = fresh;
    return fresh;
  }
  if (!moduleBaselines) moduleBaselines = new Map();
  return moduleBaselines;
}

/**
 * Surface key mirroring PlaywrightEngine.resolveSelectionContext.
 *
 * `tool` namespaces the baseline so browser_snapshot and browser_smart_snapshot
 * do not clobber each other's on a shared surface. The attrs guard would keep
 * the output correct either way, but alternating the two tools would then mean
 * neither ever diffs. browser_snapshot keeps the bare key it always had.
 */
export function snapshotSurfaceKey(
  workspaceId: string | undefined,
  surfaceId: string | undefined,
  tool?: string,
): string {
  const base = `ws:${workspaceId ?? ''}:surf:${surfaceId ?? ''}`;
  return tool === undefined ? base : `${base}:tool:${tool}`;
}

/**
 * Every key for one surface, whatever tool wrote it. Membership, not a plain
 * `startsWith`: the bare key of surface `s` is also a prefix of surface `s2`.
 */
function surfaceKeys(
  store: Map<string, SnapshotBaseline>,
  workspaceId: string | undefined,
  surfaceId: string | undefined,
): string[] {
  const base = snapshotSurfaceKey(workspaceId, surfaceId);
  const prefix = `${base}:tool:`;
  return [...store.keys()].filter((key) => key === base || key.startsWith(prefix));
}

export function getSnapshotBaseline(
  surfaceKey: string,
  attrs: string,
  url?: string,
): SnapshotBaseline | null {
  const store = getStore();
  const entry = store.get(surfaceKey);
  if (!entry) return null;
  // URL guard: when both sides know their URL and they differ, the baseline
  // describes another page — drop it. (Both undefined keeps legacy behavior
  // for callers that cannot determine a URL.)
  const urlMismatch = entry.url !== undefined && url !== undefined && entry.url !== url;
  if (entry.attrs !== attrs || urlMismatch || Date.now() - entry.ts > BASELINE_TTL_MS) {
    store.delete(surfaceKey);
    return null;
  }
  return entry;
}

export function setSnapshotBaseline(
  surfaceKey: string,
  attrs: string,
  text: string,
  url?: string,
): void {
  const store = getStore();
  // Refresh insertion order so eviction below is LRU-ish.
  store.delete(surfaceKey);
  store.set(surfaceKey, { text, attrs, ...(url !== undefined && { url }), ts: Date.now() });
  while (store.size > MAX_BASELINES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Drop every baseline for a surface (drained `navigated`/`closed` event). */
export function invalidateSnapshotBaseline(workspaceId: string | undefined, surfaceId: string | undefined): void {
  const store = getStore();
  for (const key of surfaceKeys(store, workspaceId, surfaceId)) store.delete(key);
}

/**
 * Drop the baseline unless it already describes `currentUrl`.
 *
 * Post-body drains (#1063 follow-up) use this instead of the unconditional
 * invalidate: when browser_snapshot itself ran during a navigation, the fn
 * has just written a baseline for the page's FINAL URL — nuking it would
 * self-destruct the diff cache the call just primed. A baseline whose URL
 * matches the last drained `navigated` URL is that exact case; anything else
 * (mismatch, or either URL unknown) is conservatively invalidated, because
 * the read-side URL guard in getSnapshotBaseline is fail-open when a URL is
 * missing and a stale URL-less baseline would otherwise survive forever.
 */
export function invalidateSnapshotBaselineIfStale(
  workspaceId: string | undefined,
  surfaceId: string | undefined,
  currentUrl: string | undefined,
): void {
  const store = getStore();
  for (const key of surfaceKeys(store, workspaceId, surfaceId)) {
    const entry = store.get(key);
    if (!entry) continue;
    if (entry.url !== undefined && currentUrl !== undefined && entry.url === currentUrl) continue;
    store.delete(key);
  }
}
