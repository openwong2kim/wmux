import { randomBytes } from 'crypto';
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

// ---------------------------------------------------------------------------
// Sibling store: truncated-snapshot captures for continuation cursors.
//
// Same discipline as the baselines above — per connection scope with a
// module-global fallback, a hard entry cap and a TTL — for the same reason: one
// agent must never read a window of another's capture, and a capture whose page
// is long gone must not be served as the current one.
//
// A capture is per SURFACE, not per tool: the next snapshot of that surface
// opens a new ref generation, which is precisely what would make an older
// capture's ref numbers resolve to the wrong element (or not at all). So
// storing one retires whatever the surface had.
// ---------------------------------------------------------------------------

export interface SnapshotCapture {
  /** Opaque handle; the cursor token carries this plus a line offset. */
  id: string;
  /** Bare surface key (no `:tool:` suffix) this capture froze. */
  surfaceKey: string;
  text: string;
  /** Page URL at capture time, for the same navigation guard the baselines use. */
  url?: string;
  /** Last read, not creation: an actively-paged capture is not an abandoned one. */
  ts: number;
}

/**
 * Ceiling on a single stored capture. An `aria` snapshot of a very large
 * document can run to megabytes, and a cursor exists to page through it, not to
 * pin all of it in the MCP process for the TTL. Callers cut to it through
 * capCaptureText (snapshotCursor.ts), which leaves a line naming what was
 * dropped; the slice in putSnapshotCapture is only the backstop for a caller
 * that did not.
 */
export const MAX_CAPTURE_CHARS = 1_000_000;

// Only one capture per surface is ever live, so this cap is really a bound on
// concurrently-paged surfaces — the same handful the baselines assume.
const MAX_CAPTURES = 8;
// Matches BASELINE_TTL_MS: past it the page has almost certainly moved, and a
// window of a five-minute-old tree is refs that no longer resolve.
const CAPTURE_TTL_MS = 5 * 60 * 1000;

let moduleCaptures: Map<string, SnapshotCapture> | undefined;

function getCaptureStore(): Map<string, SnapshotCapture> {
  const scope = getConnectionScope();
  if (scope) {
    const existing = scope.snapshotCaptures as Map<string, SnapshotCapture> | undefined;
    if (existing) return existing;
    const fresh = new Map<string, SnapshotCapture>();
    scope.snapshotCaptures = fresh;
    return fresh;
  }
  if (!moduleCaptures) moduleCaptures = new Map();
  return moduleCaptures;
}

/** Drop every capture of one surface (bare surface key). */
export function clearSnapshotCapturesFor(surfaceKey: string): void {
  const store = getCaptureStore();
  for (const [id, entry] of store) {
    if (entry.surfaceKey === surfaceKey) store.delete(id);
  }
}

/**
 * Store `text` as this surface's one live capture and return it.
 *
 * Replaces whatever the surface had: the caller only gets here by taking a
 * fresh snapshot, and two captures of one surface would mean a cursor into the
 * older one hands out refs the newer generation has renumbered.
 */
export function putSnapshotCapture(
  surfaceKey: string,
  text: string,
  url?: string,
): SnapshotCapture {
  const store = getCaptureStore();
  clearSnapshotCapturesFor(surfaceKey);
  let stored = text;
  if (stored.length > MAX_CAPTURE_CHARS) {
    // Back up to a line boundary so no window can ever end mid-line.
    const cut = stored.lastIndexOf('\n', MAX_CAPTURE_CHARS);
    stored = stored.slice(0, cut > 0 ? cut : MAX_CAPTURE_CHARS);
  }
  const entry: SnapshotCapture = {
    id: randomBytes(8).toString('hex'),
    surfaceKey,
    text: stored,
    ...(url !== undefined && { url }),
    ts: Date.now(),
  };
  store.set(entry.id, entry);
  while (store.size > MAX_CAPTURES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return entry;
}

/** The capture behind a cursor, or null once it has expired or been retired. */
export function getSnapshotCapture(captureId: string): SnapshotCapture | null {
  const store = getCaptureStore();
  const entry = store.get(captureId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CAPTURE_TTL_MS) {
    store.delete(captureId);
    return null;
  }
  // Idle timeout, not a lifetime: a capture at the ceiling is a couple of dozen
  // windows, and expiring a walk the agent is in the middle of would cost it
  // exactly the re-snapshot this feature exists to avoid. Staleness is caught by
  // the navigation drain and by the next snapshot of the surface — the TTL is
  // only here to free a capture nobody came back for.
  entry.ts = Date.now();
  return entry;
}

/** Drop every capture for a surface, whichever tool took it. */
function invalidateSnapshotCaptures(
  workspaceId: string | undefined,
  surfaceId: string | undefined,
): void {
  clearSnapshotCapturesFor(snapshotSurfaceKey(workspaceId, surfaceId));
}

/**
 * Post-body drain: drop a capture that describes a URL other than `currentUrl`.
 *
 * Fail-OPEN where the baseline side above fails closed — a capture that carries
 * no URL of its own is kept. The two differ because their failure modes do: a
 * stale baseline silently reports a diff against a page that no longer exists,
 * while a stale capture is text whose refs resolveRef rejects on its own
 * navigation guard, and the TTL bounds it either way. Fail-closed here would
 * have deleted the capture the very call that minted it just stored, on any lane
 * that cannot name its URL — handing the agent a cursor already dead on arrival.
 */
function invalidateSnapshotCapturesIfStale(
  workspaceId: string | undefined,
  surfaceId: string | undefined,
  currentUrl: string | undefined,
): void {
  const store = getCaptureStore();
  const surfaceKey = snapshotSurfaceKey(workspaceId, surfaceId);
  for (const [id, entry] of store) {
    if (entry.surfaceKey !== surfaceKey) continue;
    if (entry.url === undefined || currentUrl === undefined || entry.url === currentUrl) continue;
    store.delete(id);
  }
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

/**
 * Drop every baseline for a surface (drained `navigated`/`closed` event).
 *
 * Continuation captures go with them: a window of the pre-navigation tree is a
 * list of refs into a document that no longer exists, so the cursor must fail
 * loudly instead of serving it.
 */
export function invalidateSnapshotBaseline(workspaceId: string | undefined, surfaceId: string | undefined): void {
  const store = getStore();
  for (const key of surfaceKeys(store, workspaceId, surfaceId)) store.delete(key);
  invalidateSnapshotCaptures(workspaceId, surfaceId);
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
  // Captures follow the same rule, and for the same reason: the capture this
  // very call just stored is the one whose URL matches the landing.
  invalidateSnapshotCapturesIfStale(workspaceId, surfaceId, currentUrl);
}
