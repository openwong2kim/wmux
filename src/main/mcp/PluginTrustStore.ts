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
import type { PluginIdentityRecord } from '../../shared/rpc';
import {
  applyContact,
  applyDeclaration,
  unconfirmedIdentity,
} from './PluginIdentity';

export const PLUGIN_TRUST_SCHEMA_VERSION = 1 as const;

export interface PluginTrustDb {
  schemaVersion: number;
  plugins: Record<string, PluginIdentityRecord>;
}

function emptyDb(): PluginTrustDb {
  return { schemaVersion: PLUGIN_TRUST_SCHEMA_VERSION, plugins: {} };
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
  // future versions are accepted as-is (forward-compat); v1 entries
  // missing optional fields are passed through unchanged.
  private normalize(parsed: PluginTrustDb | null): PluginTrustDb {
    if (!parsed || typeof parsed !== 'object') return emptyDb();
    const schemaVersion =
      typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > 0
        ? parsed.schemaVersion
        : PLUGIN_TRUST_SCHEMA_VERSION;
    const plugins =
      parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
    return { schemaVersion, plugins };
  }

  async get(name: string): Promise<PluginIdentityRecord | undefined> {
    const db = await this.load();
    return db.plugins[name];
  }

  async list(): Promise<PluginIdentityRecord[]> {
    const db = await this.load();
    return Object.values(db.plugins);
  }

  // Record a first contact (or refresh `lastSeen`/`version` on a known
  // plugin). Returns the post-write record.
  async upsertContact(
    name: string,
    version?: string,
  ): Promise<PluginIdentityRecord> {
    return this.mutate((db) => {
      const existing = db.plugins[name];
      const next = existing
        ? applyContact(existing, version)
        : unconfirmedIdentity(name, version);
      db.plugins[name] = next;
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
    return this.mutate((db) => {
      const existing = db.plugins[name] ?? unconfirmedIdentity(name, version);
      const next = applyDeclaration(existing, capabilities, rationale);
      db.plugins[name] = next;
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
