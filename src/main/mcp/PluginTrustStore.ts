// PluginTrustStore — persists declared MCP plugin identities to
// `~/.wmux/plugin-trust.json` so substrate can track who connected, what
// capabilities they claimed they would need, and what trust state the user
// has assigned. NOT a secret store (no credentials).
//
// All writes go through `atomicWriteJSON` to avoid torn files on crash.
// Reads tolerate a missing/corrupt file by treating it as an empty DB so
// substrate boot never fails on first-run.
//
// Concurrency: the store is intentionally single-instance per main process.
// The `load → mutate → write` cycle is serialised inside the class via a
// shared promise chain to prevent interleaved writes from clobbering each
// other in burst workloads (e.g. 10 plugins reconnecting simultaneously).

import * as fs from 'fs';
import {
  atomicWriteJSON,
  atomicReadJSON,
} from '../../daemon/util/atomicWrite';
import { getPluginTrustPath, getWmuxHomeDir } from '../../shared/constants';
import type { PluginIdentityRecord, PluginTrustStatus } from '../../shared/rpc';
import {
  applyContact,
  applyDeclaration,
  legacyIdentity,
  unconfirmedIdentity,
} from './PluginIdentity';

export const PLUGIN_TRUST_SCHEMA_VERSION = 1 as const;

// Plugin names ride in over the wire from any client holding the wmux auth
// token. Cap the key length so a malicious caller can't grow plugin-trust.json
// unboundedly. 256 chars is generous for `org.tool-name@semver` patterns; the
// DB-wide entry cap is a separate enforcement-PR concern.
export const MAX_PLUGIN_NAME_LEN = 256 as const;

export interface PluginTrustDb {
  schemaVersion: number;
  plugins: Record<string, PluginIdentityRecord>;
}

// All plugin maps use a null-prototype object so a clientName like
// "__proto__" / "toString" / "hasOwnProperty" can never collide with
// Object.prototype and either read inherited values or mutate the prototype.
function newPluginMap(): Record<string, PluginIdentityRecord> {
  return Object.create(null);
}

function emptyDb(): PluginTrustDb {
  return { schemaVersion: PLUGIN_TRUST_SCHEMA_VERSION, plugins: newPluginMap() };
}

// Defensive own-property lookup. db.plugins is built from JSON.parse output
// or hand-constructed null-proto maps, but a corrupt/forward-compat read
// could still hand us a prototype-tainted object — never trust the shape.
function ownPlugin(
  db: PluginTrustDb,
  name: string,
): PluginIdentityRecord | undefined {
  return Object.prototype.hasOwnProperty.call(db.plugins, name)
    ? db.plugins[name]
    : undefined;
}

const KNOWN_STATUSES: ReadonlySet<PluginTrustStatus> = new Set([
  'unconfirmed',
  'trusted',
  'denied',
  'legacy',
]);

// Coerce a freshly-loaded record into a valid PluginIdentityRecord. Drops
// entries whose `status` isn't one of the four known values so downstream
// transitions never branch on `undefined`. Forward-compat: extra fields are
// passed through unchanged.
function normalizeRecord(raw: unknown): PluginIdentityRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<PluginIdentityRecord>;
  if (typeof r.name !== 'string' || r.name.length === 0) return undefined;
  if (!r.status || !KNOWN_STATUSES.has(r.status as PluginTrustStatus)) {
    return undefined;
  }
  return r as PluginIdentityRecord;
}

// Bound plugin name length so a hostile clientName can't disk-fill us. We
// truncate rather than reject because the trust DB write is best-effort
// from RpcRouter's legacy path; a thrown error would lose the audit entry.
function clampName(name: string): string {
  return name.length <= MAX_PLUGIN_NAME_LEN
    ? name
    : name.slice(0, MAX_PLUGIN_NAME_LEN);
}

function ensureWmuxHomeDir(): void {
  const dir = getWmuxHomeDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // mkdir failures bubble up later when atomicWriteJSON tries to write
  }
}

export class PluginTrustStore {
  private readonly path: string;
  private cache: PluginTrustDb | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(targetPath: string = getPluginTrustPath()) {
    this.path = targetPath;
  }

  // Read the on-disk DB, tolerating absence and corruption. Cached in
  // memory until the next write so subsequent reads don't re-parse JSON.
  async load(): Promise<PluginTrustDb> {
    if (this.cache) return this.cache;
    try {
      const parsed = await atomicReadJSON<PluginTrustDb>(this.path);
      this.cache = this.normalize(parsed);
    } catch (err) {
      // Corrupt file or unexpected I/O error — surface a warning but boot
      // anyway. Future PR can decide whether to quarantine the bad file.
      // eslint-disable-next-line no-console
      console.warn(
        `[PluginTrustStore] load failed, starting empty: ${String(err)}`,
      );
      this.cache = emptyDb();
    }
    return this.cache;
  }

  // Coerce whatever was on disk into the current schema shape. Unknown
  // future versions are accepted as-is (forward-compat); v1 entries with
  // valid `name` + `status` pass through; malformed entries are dropped
  // (silently — boot tolerance trumps strict validation here).
  private normalize(parsed: PluginTrustDb | null): PluginTrustDb {
    if (!parsed || typeof parsed !== 'object') return emptyDb();
    const schemaVersion =
      typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > 0
        ? parsed.schemaVersion
        : PLUGIN_TRUST_SCHEMA_VERSION;
    const sourcePlugins =
      parsed.plugins && typeof parsed.plugins === 'object'
        ? (parsed.plugins as Record<string, unknown>)
        : {};
    const plugins = newPluginMap();
    for (const key of Object.keys(sourcePlugins)) {
      if (!Object.prototype.hasOwnProperty.call(sourcePlugins, key)) continue;
      const rec = normalizeRecord(sourcePlugins[key]);
      if (rec) plugins[clampName(key)] = rec;
    }
    return { schemaVersion, plugins };
  }

  async get(name: string): Promise<PluginIdentityRecord | undefined> {
    const db = await this.load();
    return ownPlugin(db, clampName(name));
  }

  async list(): Promise<PluginIdentityRecord[]> {
    const db = await this.load();
    return Object.keys(db.plugins).map((k) => db.plugins[k]);
  }

  // Record a first contact (or refresh `lastSeen`/`version` on a known
  // plugin). Returns the post-write record.
  async upsertContact(
    name: string,
    version?: string,
  ): Promise<PluginIdentityRecord> {
    const safeName = clampName(name);
    return this.mutate((db) => {
      const existing = ownPlugin(db, safeName);
      const next = existing
        ? applyContact(existing, version)
        : unconfirmedIdentity(safeName, version);
      db.plugins[safeName] = next;
      return next;
    });
  }

  // Record a declared capability set. If no contact has been recorded yet
  // (e.g. plugin skipped `mcp.identify`), this seeds a fresh entry.
  async upsertDeclaration(
    name: string,
    capabilities: string[],
    rationale?: string,
    version?: string,
  ): Promise<PluginIdentityRecord> {
    const safeName = clampName(name);
    return this.mutate((db) => {
      const existing =
        ownPlugin(db, safeName) ?? unconfirmedIdentity(safeName, version);
      const next = applyDeclaration(existing, capabilities, rationale);
      db.plugins[safeName] = next;
      return next;
    });
  }

  // Record an RPC call that arrived without a clientName envelope.
  // Pre-v2.10 callers and the wmux-bundled MCP server's pre-handshake RPCs
  // land here. Status is `legacy` on first contact and refreshes via
  // applyContact (which respects the trust-status invariant) on repeats.
  // Caller controls the name; defaults to 'unknown' so all envelope-less
  // callers collapse to a single audit entry instead of fragmenting the DB.
  async upsertLegacyContact(
    name?: string,
    version?: string,
  ): Promise<PluginIdentityRecord> {
    const safeName = clampName(
      typeof name === 'string' && name.trim().length > 0
        ? name.trim()
        : 'unknown',
    );
    return this.mutate((db) => {
      const existing = ownPlugin(db, safeName);
      const next = existing
        ? applyContact(existing, version)
        : legacyIdentity(safeName);
      db.plugins[safeName] = next;
      return next;
    });
  }

  // Serialise a mutation behind the write chain so two callers don't race
  // on `load → mutate → persist`. The mutator may read AND write the db
  // in place; we then re-cache and persist atomically.
  private mutate<T>(mutator: (db: PluginTrustDb) => T): Promise<T> {
    const chained = this.writeChain.then(async () => {
      const db = await this.load();
      const result = mutator(db);
      this.cache = db;
      ensureWmuxHomeDir();
      await atomicWriteJSON(this.path, db);
      return result;
    });
    this.writeChain = chained.then(
      () => undefined,
      () => undefined, // swallow errors in chain so one bad write doesn't block the next
    );
    return chained;
  }

  // Test-only: drop in-memory cache so next read goes to disk.
  invalidateCache(): void {
    this.cache = null;
  }
}

// Process-singleton accessor — the trust store has no per-call state and
// must serialise writes globally. Tests can construct standalone instances
// with a custom path.
let singleton: PluginTrustStore | null = null;

export function getPluginTrustStore(): PluginTrustStore {
  if (!singleton) singleton = new PluginTrustStore();
  return singleton;
}

// Test-only reset hook so unit tests can swap in a fresh store after
// pointing the path env at a tmpdir.
export function __resetPluginTrustStoreForTests(): void {
  singleton = null;
}
