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
const MAX_BASELINES = 8;
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

/** Surface key mirroring PlaywrightEngine.resolveSelectionContext. */
export function snapshotSurfaceKey(workspaceId: string | undefined, surfaceId: string | undefined): string {
  return `ws:${workspaceId ?? ''}:surf:${surfaceId ?? ''}`;
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

/** Drop the baseline for a surface (drained `navigated`/`closed` event). */
export function invalidateSnapshotBaseline(workspaceId: string | undefined, surfaceId: string | undefined): void {
  getStore().delete(snapshotSurfaceKey(workspaceId, surfaceId));
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
  const key = snapshotSurfaceKey(workspaceId, surfaceId);
  const entry = store.get(key);
  if (!entry) return;
  if (entry.url !== undefined && currentUrl !== undefined && entry.url === currentUrl) return;
  store.delete(key);
}
