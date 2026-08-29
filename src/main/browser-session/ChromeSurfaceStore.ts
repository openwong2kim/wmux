import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';

// ---------------------------------------------------------------------------
// Stable surface identity for the 'chrome' backend.
//
// A Chrome CDP targetId is NOT a stable handle: Chrome replaces the target
// behind a tab on its own (the first-run sync flow does exactly this), and an
// app restart loses every in-memory mapping. Handing that id to agents as the
// MCP surfaceId broke the contract in shared/browserTabs.ts ("surfaceId —
// never a CDP target id") and left agents holding dead references.
//
// So the launcher mints its own `chrome-<uuid>` surfaceId, and this store
// persists the surfaceId → targetId mapping across restarts. targetId becomes
// mutable state ON the record rather than the record's identity.
//
// ── Revival: when may a persisted record re-bind to a live Chrome tab? ──
//
//   ① The record's `tabTargetId` (the CDP *tab* target, which outlives the
//      page target it wraps) is still present in Chrome → deterministic
//      re-bind. Filled in by the follow-up PR; the field is carried here so
//      records written today survive into that release.
//   ② The record's `targetId` is still present in Chrome's /json/list → the
//      exact page is still there, so re-bind (the adopt path after a crash,
//      where Chrome outlived wmux).
//   ③ Anything else → do NOT re-bind. The record stays unbound until it ages
//      out, and the agent gets an explicit "this surface is gone" error.
//
// Revival by URL match is deliberately excluded. Chrome's session restore
// reopens the same URLs after a restart, so a URL match is easy to implement
// and almost always wrong: the restored tab is a different browsing context
// with different cookies-in-memory, scroll, history stack, and JS state.
// Handing an agent a page that *looks* right but is not the one it was
// working in is a worse failure mode than the current bug — it turns a loud
// dead-reference error into silent action on the wrong page.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
/** Per profile. A working set, not a history — the cap is generous. */
export const MAX_SURFACES_PER_PROFILE = 200;
/** A record untouched for this long is forgotten on the next load/prune. */
export const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a record survives after its targetId stops appearing in Chrome. */
export const ORPHAN_TTL_MS = 5 * 60 * 1000;
/** Coalescing window for the high-frequency lastSeenAt/url churn. */
export const WRITE_DEBOUNCE_MS = 300;

export interface ChromeSurfaceRecord {
  /** chrome-<uuid> — the only id agents ever see. */
  surfaceId: string;
  /** Current CDP page targetId (mutable; null = unbound, no live tab). */
  targetId: string | null;
  /** Stable CDP tab-target anchor (filled by the follow-up PR). */
  tabTargetId?: string;
  workspaceId?: string;
  url: string;
  title?: string;
  createdAt: number;
  lastSeenAt: number;
  /** First time the targetId went missing from Chrome; cleared on return. */
  missingSince?: number;
}

interface ChromeSurfacesFile {
  version: number;
  profiles: Record<string, ChromeSurfaceRecord[]>;
}

export function getChromeSurfacesPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'chrome-tabs.json');
}

function emptyFile(): ChromeSurfacesFile {
  return { version: SCHEMA_VERSION, profiles: {} };
}

function sanitizeRecord(raw: unknown, now: number): ChromeSurfaceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.surfaceId !== 'string' || r.surfaceId.length === 0) return null;
  if (typeof r.url !== 'string') return null;
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now;
  const lastSeenAt = typeof r.lastSeenAt === 'number' && Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : createdAt;
  if (now - lastSeenAt > RECORD_TTL_MS) return null; // lazy TTL prune
  return {
    surfaceId: r.surfaceId,
    targetId: typeof r.targetId === 'string' && r.targetId.length > 0 ? r.targetId : null,
    ...(typeof r.tabTargetId === 'string' && r.tabTargetId.length > 0 && { tabTargetId: r.tabTargetId }),
    ...(typeof r.workspaceId === 'string' && r.workspaceId.length > 0 && { workspaceId: r.workspaceId }),
    url: r.url,
    ...(typeof r.title === 'string' && { title: r.title }),
    createdAt,
    lastSeenAt,
    ...(typeof r.missingSince === 'number' && Number.isFinite(r.missingSince) && { missingSince: r.missingSince }),
  };
}

/** Drop anything malformed; fail open — a torn store must never brick
 *  browser automation, it must only cost the agent its tab handles. */
function sanitizeFile(raw: unknown, now: number = Date.now()): ChromeSurfacesFile {
  const file = emptyFile();
  if (!raw || typeof raw !== 'object') return file;
  const r = raw as Record<string, unknown>;
  if (!r.profiles || typeof r.profiles !== 'object') return file;
  for (const [profile, list] of Object.entries(r.profiles as Record<string, unknown>)) {
    if (isUnsafeKey(profile)) continue; // prototype-pollution guard
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    const records: ChromeSurfaceRecord[] = [];
    for (const entry of list) {
      const record = sanitizeRecord(entry, now);
      if (!record || seen.has(record.surfaceId)) continue;
      seen.add(record.surfaceId);
      records.push(record);
    }
    // Over the cap, the oldest lose (same rule as the write path).
    file.profiles[profile] = records.length > MAX_SURFACES_PER_PROFILE
      ? records.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_SURFACES_PER_PROFILE)
      : records;
  }
  return file;
}

/**
 * Persistence for chrome-backend surface records, one JSON file for all
 * profiles. Modeled on ChromeProfileStore: sync cache-backed reads, mutations
 * serialized through a write chain so overlapping read-modify-writes never
 * race, fail-open sanitize on load.
 *
 * The launcher owns the authoritative in-memory records and publishes whole
 * per-profile snapshots here, so there is no per-record merge to get wrong.
 * `save()` coalesces the frequent lastSeenAt/url churn over WRITE_DEBOUNCE_MS;
 * structural changes (open/close/dispose) use `saveNow()`.
 */
export class ChromeSurfaceStore {
  private readonly filePath: string;
  private cache: ChromeSurfacesFile | null = null;
  /** Serialized write chain — every mutation awaits the previous one. */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Debounced snapshots not yet on disk, keyed by profile. */
  private readonly pending = new Map<string, ChromeSurfaceRecord[]>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir?: string) {
    this.filePath = getChromeSurfacesPath(dir);
  }

  /** Load (or reload) from disk. Missing/corrupt loads as an empty file. */
  load(): ChromeSurfacesFile {
    let raw: unknown = null;
    try {
      raw = atomicReadJSONSync<unknown>(this.filePath);
    } catch {
      raw = null;
    }
    this.cache = sanitizeFile(raw);
    return this.cache;
  }

  private ensureCache(): ChromeSurfacesFile {
    return this.cache ?? this.load();
  }

  /** The persisted records for a profile (already TTL-pruned by sanitize). */
  listForProfile(profile: string): ChromeSurfaceRecord[] {
    if (isUnsafeKey(profile)) return [];
    // A pending snapshot is newer than the cache it will replace.
    const queued = this.pending.get(profile);
    if (queued) return queued.map((r) => ({ ...r }));
    return (this.ensureCache().profiles[profile] ?? []).map((r) => ({ ...r }));
  }

  /** Publish a profile snapshot, coalescing writes over WRITE_DEBOUNCE_MS. */
  save(profile: string, records: readonly ChromeSurfaceRecord[]): void {
    if (isUnsafeKey(profile)) return;
    this.pending.set(profile, records.map((r) => ({ ...r })));
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain().catch(() => undefined);
    }, WRITE_DEBOUNCE_MS);
    // Never hold the event loop open for a cosmetic-ish write.
    (this.debounceTimer as { unref?: () => void }).unref?.();
  }

  /** Publish a profile snapshot and write it out immediately. */
  async saveNow(profile: string, records: readonly ChromeSurfaceRecord[]): Promise<void> {
    if (isUnsafeKey(profile)) return;
    this.pending.set(profile, records.map((r) => ({ ...r })));
    await this.drain();
  }

  /** Forget a profile entirely (its Chrome was freshly spawned — the tabs
   *  those records described no longer exist anywhere). */
  async dropProfile(profile: string): Promise<void> {
    await this.saveNow(profile, []);
  }

  /** Flush every pending snapshot synchronously (app teardown). */
  flushSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pending.size === 0) return;
    try {
      const file = this.readForMutation();
      this.applyPending(file);
      atomicWriteJSONSync(this.filePath, file, { durable: true });
      this.cache = file;
    } catch (err) {
      console.warn('[ChromeSurfaceStore] flushSync failed:', err);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private readForMutation(): ChromeSurfacesFile {
    // Detached reload (accountStore idiom): a failed write leaves the
    // published cache exactly as last committed.
    let raw: unknown = null;
    try {
      raw = atomicReadJSONSync<unknown>(this.filePath);
    } catch {
      raw = null;
    }
    return sanitizeFile(raw);
  }

  /** Move every queued snapshot onto `file`, then clear the queue. */
  private applyPending(file: ChromeSurfacesFile): void {
    const now = Date.now();
    for (const [profile, records] of this.pending) {
      const fresh = records.filter((r) => now - r.lastSeenAt <= RECORD_TTL_MS);
      // Over the cap, the OLDEST records lose — an agent's newest handles are
      // the ones it is still holding.
      const capped = fresh.length > MAX_SURFACES_PER_PROFILE
        ? [...fresh].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_SURFACES_PER_PROFILE)
        : fresh;
      const kept: ChromeSurfaceRecord[] = [];
      const seen = new Set<string>();
      for (const record of capped) {
        if (seen.has(record.surfaceId)) continue;
        seen.add(record.surfaceId);
        kept.push({ ...record });
      }
      if (kept.length === 0) delete file.profiles[profile];
      else file.profiles[profile] = kept;
    }
    this.pending.clear();
  }

  private drain(): Promise<void> {
    const run = this.writeChain.then(async () => {
      if (this.pending.size === 0) return;
      const file = this.readForMutation();
      this.applyPending(file);
      await atomicWriteJSON(this.filePath, file, { durable: true });
      this.cache = file;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}
