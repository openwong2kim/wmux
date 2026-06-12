// ProjectConfigStore — discovery + trust gate for per-project `wmux.json` (X5).
//
// Discovery: walk UP from a workspace's cwd looking for `wmux.json`, stopping
// at the repo boundary (a directory containing `.git` — file or dir, so linked
// worktrees count), the filesystem root, or a depth cap. "Open this repo →
// get its layout" semantics without configuring anything.
//
// Trust: `wmux.json` is CHECKED INTO THE REPO, so a malicious PR can edit it.
// Nothing executes until the user explicitly trusts the file, and the grant is
// bound to a sha256 of the exact bytes the user reviewed — any later edit
// demotes the project to 'stale' (display-only) until re-approved. Decisions
// persist in `~/.wmux/project-trust.json` (atomicWriteJSON, same crash-safety
// as PluginTrustStore; a separate file because plugin trust is keyed by client
// NAME while project trust is keyed by PATH+CONTENT).
//
// 'denied' is sticky for the path regardless of content changes — a user who
// said "never run things from this repo" shouldn't be re-prompted by every
// edit; the sidebar badge remains the explicit re-evaluation entry point.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { atomicWriteJSON, atomicReadJSON } from '../../daemon/util/atomicWrite';
import { getWmuxHomeDir } from '../../shared/constants';
import {
  normalizeWmuxProjectConfig,
  PROJECT_CONFIG_MAX_FILE_BYTES,
  WMUX_PROJECT_CONFIG_FILENAME,
  type ProjectConfigState,
  type ProjectTrustState,
  type WmuxProjectConfig,
} from '../../shared/wmuxProjectConfig';

export type { ProjectConfigState, ProjectTrustState };

export const PROJECT_TRUST_SCHEMA_VERSION = 1 as const;

/** Walk no further than this many directories above the starting cwd. */
export const PROJECT_CONFIG_MAX_WALK_DEPTH = 16;

/** Trust DB growth guard. Every record is a user decision (no auto-seeded
 * entries), so unlike PluginTrustStore there is no eviction — we just refuse
 * to add NEW roots past the cap (existing roots stay updatable). */
export const MAX_PROJECT_TRUST_ENTRIES = 512;

export interface ProjectTrustRecord {
  status: 'trusted' | 'denied';
  /** sha256 (hex) of the wmux.json bytes the user reviewed when deciding. */
  contentHash: string;
  decidedAt: number;
}

export interface ProjectTrustDb {
  schemaVersion: number;
  projects: Record<string, ProjectTrustRecord>;
}

export function getProjectTrustPath(): string {
  return `${getWmuxHomeDir()}/project-trust.json`;
}

/** Canonical trust-DB key for a project root. Windows paths are
 * case-insensitive, so lowercase; trailing separators stripped. */
export function normalizeProjectRoot(dir: string): string {
  let resolved = path.resolve(dir);
  // Strip trailing separators except for bare drive roots ("C:\").
  while (resolved.length > 3 && (resolved.endsWith('\\') || resolved.endsWith('/'))) {
    resolved = resolved.slice(0, -1);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function newProjectMap(): Record<string, ProjectTrustRecord> {
  // Null prototype so a hostile root path like "__proto__" can't collide
  // with Object.prototype (same defense as PluginTrustStore).
  return Object.create(null);
}

function emptyDb(): ProjectTrustDb {
  return { schemaVersion: PROJECT_TRUST_SCHEMA_VERSION, projects: newProjectMap() };
}

function normalizeRecord(raw: unknown): ProjectTrustRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<ProjectTrustRecord>;
  if (r.status !== 'trusted' && r.status !== 'denied') return undefined;
  if (typeof r.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.contentHash)) return undefined;
  const decidedAt = typeof r.decidedAt === 'number' && Number.isFinite(r.decidedAt) ? r.decidedAt : 0;
  return { status: r.status, contentHash: r.contentHash, decidedAt };
}

interface ConfigCacheEntry {
  mtimeMs: number;
  size: number;
  contentHash: string;
  config: WmuxProjectConfig | undefined;
}

export interface ProjectConfigStoreOptions {
  /** Override the trust-DB entry cap (default MAX_PROJECT_TRUST_ENTRIES). */
  entryCap?: number;
}

export class ProjectConfigStore {
  private readonly trustPath: string;
  private readonly entryCap: number;
  private trustCache: ProjectTrustDb | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  /** Parse cache keyed by configPath; invalidated by mtime+size change. */
  private readonly configCache = new Map<string, ConfigCacheEntry>();

  constructor(trustPath: string = getProjectTrustPath(), options: ProjectConfigStoreOptions = {}) {
    this.trustPath = trustPath;
    this.entryCap =
      typeof options.entryCap === 'number' && options.entryCap > 0
        ? Math.floor(options.entryCap)
        : MAX_PROJECT_TRUST_ENTRIES;
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  /** Find the nearest wmux.json at/above `startCwd` (repo-boundary aware).
   * Returns the directory that holds it, or null. */
  findConfigDir(startCwd: string): string | null {
    let dir: string;
    try {
      dir = path.resolve(startCwd);
      if (!fs.statSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
    for (let i = 0; i <= PROJECT_CONFIG_MAX_WALK_DEPTH; i++) {
      const candidate = path.join(dir, WMUX_PROJECT_CONFIG_FILENAME);
      try {
        if (fs.statSync(candidate).isFile()) return dir;
      } catch {
        // not here — keep walking
      }
      // Repo boundary: a `.git` entry (dir, or file for linked worktrees)
      // means `dir` IS the project root — don't escape into parent repos
      // or unrelated directories above it.
      try {
        fs.statSync(path.join(dir, '.git'));
        return null;
      } catch {
        // no .git here — continue up
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // filesystem root
      dir = parent;
    }
    return null;
  }

  /** Read + parse wmux.json in `dir`, with an mtime+size cache. */
  private readConfig(dir: string): { contentHash: string; config: WmuxProjectConfig | undefined } | null {
    const configPath = path.join(dir, WMUX_PROJECT_CONFIG_FILENAME);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(configPath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > PROJECT_CONFIG_MAX_FILE_BYTES) return null;

    const cached = this.configCache.get(configPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { contentHash: cached.contentHash, config: cached.config };
    }

    let raw: Buffer;
    try {
      raw = fs.readFileSync(configPath);
    } catch {
      return null;
    }
    const contentHash = sha256Hex(raw);
    let config: WmuxProjectConfig | undefined;
    try {
      config = normalizeWmuxProjectConfig(JSON.parse(raw.toString('utf8')));
    } catch {
      config = undefined; // invalid JSON → found-but-invalid
    }
    this.configCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, contentHash, config });
    return { contentHash, config };
  }

  // ── State for the renderer ─────────────────────────────────────────────────

  async getState(cwd: string): Promise<ProjectConfigState> {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) return { found: false };
    const dir = this.findConfigDir(cwd.trim());
    if (dir === null) return { found: false };
    const read = this.readConfig(dir);
    if (read === null) return { found: false };

    const root = normalizeProjectRoot(dir);
    const configPath = path.join(dir, WMUX_PROJECT_CONFIG_FILENAME);
    if (read.config === undefined) {
      // Exists but unusable — surfaced so the renderer can hint at a typo
      // instead of silently doing nothing.
      return { found: true, root, configPath, invalid: true, contentHash: read.contentHash };
    }

    const record = await this.getRecord(root);
    let trust: ProjectTrustState;
    if (!record) trust = 'untrusted';
    else if (record.status === 'denied') trust = 'denied';
    else trust = record.contentHash === read.contentHash ? 'trusted' : 'stale';

    return { found: true, root, configPath, config: read.config, contentHash: read.contentHash, trust };
  }

  // ── Trust DB ───────────────────────────────────────────────────────────────

  private async load(): Promise<ProjectTrustDb> {
    if (this.trustCache) return this.trustCache;
    try {
      const parsed = await atomicReadJSON<ProjectTrustDb>(this.trustPath);
      this.trustCache = this.normalizeDb(parsed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ProjectConfigStore] trust load failed, starting empty: ${String(err)}`);
      this.trustCache = emptyDb();
    }
    return this.trustCache;
  }

  private normalizeDb(parsed: ProjectTrustDb | null): ProjectTrustDb {
    if (!parsed || typeof parsed !== 'object') return emptyDb();
    const source = parsed.projects && typeof parsed.projects === 'object'
      ? (parsed.projects as Record<string, unknown>)
      : {};
    const projects = newProjectMap();
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const rec = normalizeRecord(source[key]);
      if (rec) projects[key] = rec;
    }
    return { schemaVersion: PROJECT_TRUST_SCHEMA_VERSION, projects };
  }

  async getRecord(root: string): Promise<ProjectTrustRecord | undefined> {
    const db = await this.load();
    const key = normalizeProjectRoot(root);
    return Object.prototype.hasOwnProperty.call(db.projects, key) ? db.projects[key] : undefined;
  }

  /**
   * Persist a user decision. `contentHash` must be the hash the approval UI
   * DISPLAYED — if the file changed while the dialog was open, the grant
   * binds to the reviewed bytes and the live file evaluates as 'stale',
   * never silently approving unseen content.
   */
  async setDecision(root: string, status: 'trusted' | 'denied', contentHash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('Invalid content hash');
    const key = normalizeProjectRoot(root);
    await this.mutate((db) => {
      const exists = Object.prototype.hasOwnProperty.call(db.projects, key);
      if (!exists && Object.keys(db.projects).length >= this.entryCap) {
        throw new Error('Project trust DB is full');
      }
      db.projects[key] = { status, contentHash, decidedAt: Date.now() };
    });
  }

  /** Forget a decision (the "revoke" path in the sidebar badge menu). */
  async clearDecision(root: string): Promise<void> {
    const key = normalizeProjectRoot(root);
    await this.mutate((db) => {
      delete db.projects[key];
    });
  }

  // Serialise mutations behind a write chain (PluginTrustStore pattern) so
  // concurrent IPC calls can't interleave load→mutate→write cycles.
  private async mutate(fn: (db: ProjectTrustDb) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const db = await this.load();
      fn(db);
      this.trustCache = db;
      await atomicWriteJSON(this.trustPath, db);
    });
    // Keep the chain alive on failure but propagate the error to THIS caller.
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}

let storeInstance: ProjectConfigStore | null = null;

export function getProjectConfigStore(): ProjectConfigStore {
  if (!storeInstance) storeInstance = new ProjectConfigStore();
  return storeInstance;
}

/** Test seam. */
export function resetProjectConfigStoreForTest(): void {
  storeInstance = null;
}
