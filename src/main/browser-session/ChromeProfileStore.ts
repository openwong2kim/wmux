import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import { validateBrowserProfileName } from './ProfileManager';

// ---------------------------------------------------------------------------
// Chrome-backend profile registry + workspace bindings (Phase 2.5).
//
// One named profile = one --user-data-dir = one Chrome instance with its own
// persistent logins. A workspace binds to a profile so workspace 1 can drive
// Chrome signed into account A while workspace 2 drives account B. Binding is
// a USER action from the workspace card menu — never agent-selectable — so
// the binding itself is the authorization (SELECTABLE_RPC_PROFILES
// philosophy in ProfileManager.ts).
//
// Modeled on account/accountStore.ts: main-owned JSON in the wmux data dir
// (WMUX_DATA_SUFFIX-isolated), sync cache-backed reads, mutations serialized
// through a write chain so overlapping read-modify-writes never race.
// ---------------------------------------------------------------------------

export const DEFAULT_CHROME_PROFILE = 'default';
const SCHEMA_VERSION = 1;
const MAX_PROFILES = 20;

/** workspaceId → profileName */
export type ChromeProfileBindings = Record<string, string>;

interface ChromeProfilesFile {
  version: number;
  profiles: string[];
  bindings: ChromeProfileBindings;
}

export function getChromeProfilesPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'chrome-profiles.json');
}

function emptyFile(): ChromeProfilesFile {
  return { version: SCHEMA_VERSION, profiles: [DEFAULT_CHROME_PROFILE], bindings: {} };
}

function isValidProfileName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  try {
    validateBrowserProfileName(name);
    return true;
  } catch {
    return false;
  }
}

/** Drop anything malformed; guarantee 'default' exists; drop bindings that
 *  point at unknown profiles or (when known) unknown workspaces. */
function sanitizeFile(raw: unknown, knownWorkspaceIds?: ReadonlySet<string>): ChromeProfilesFile {
  const file = emptyFile();
  if (!raw || typeof raw !== 'object') return file;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.profiles)) {
    for (const p of r.profiles) {
      if (isValidProfileName(p) && !file.profiles.includes(p) && file.profiles.length < MAX_PROFILES) {
        file.profiles.push(p);
      }
    }
  }
  if (r.bindings && typeof r.bindings === 'object') {
    for (const [wsId, profile] of Object.entries(r.bindings as Record<string, unknown>)) {
      if (isUnsafeKey(wsId)) continue;
      if (!isValidProfileName(profile) || !file.profiles.includes(profile)) continue;
      // Lazy prune: a wiped session.json re-mints workspace UUIDs; bindings to
      // ids nobody knows any more are dropped on load instead of lingering.
      if (knownWorkspaceIds && !knownWorkspaceIds.has(wsId)) continue;
      file.bindings[wsId] = profile;
    }
  }
  return file;
}

export class ChromeProfileError extends Error {
  readonly code: 'invalid' | 'limit' | 'not-found';
  constructor(code: ChromeProfileError['code'], message: string) {
    super(message);
    this.name = 'ChromeProfileError';
    this.code = code;
  }
}

export class ChromeProfileStore {
  private readonly filePath: string;
  private cache: ChromeProfilesFile | null = null;
  /** Serialized write chain — every mutation awaits the previous one. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dir?: string) {
    this.filePath = getChromeProfilesPath(dir);
  }

  /** Load (or reload) from disk. Missing/corrupt loads as the default file
   *  (fail open — a torn store must never brick browser automation). */
  load(knownWorkspaceIds?: ReadonlySet<string>): ChromeProfilesFile {
    let raw: unknown = null;
    try {
      raw = atomicReadJSONSync<unknown>(this.filePath);
    } catch {
      raw = null;
    }
    this.cache = sanitizeFile(raw, knownWorkspaceIds);
    return this.cache;
  }

  private ensureCache(): ChromeProfilesFile {
    return this.cache ?? this.load();
  }

  // ── Sync reads (cache-backed; automation hot path) ────────────────────────

  listProfiles(): string[] {
    return [...this.ensureCache().profiles];
  }

  getBindings(): ChromeProfileBindings {
    return { ...this.ensureCache().bindings };
  }

  /** The profile a workspace's automation runs in ('default' when unbound). */
  profileFor(workspaceId: string | undefined): string {
    if (!workspaceId || isUnsafeKey(workspaceId)) return DEFAULT_CHROME_PROFILE;
    return this.ensureCache().bindings[workspaceId] ?? DEFAULT_CHROME_PROFILE;
  }

  // ── Mutations (serialized) ────────────────────────────────────────────────

  private mutate<T>(fn: (file: ChromeProfilesFile) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      // Detached reload (accountStore idiom): a failed write leaves the
      // published cache exactly as last committed.
      let raw: unknown = null;
      try { raw = atomicReadJSONSync<unknown>(this.filePath); } catch { raw = null; }
      const file = sanitizeFile(raw);
      const result = fn(file);
      await atomicWriteJSON(this.filePath, file, { durable: true });
      this.cache = file;
      return result;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async create(name: string): Promise<string> {
    validateBrowserProfileName(name); // throws its user-facing message
    return this.mutate((file) => {
      if (file.profiles.includes(name)) return name; // idempotent
      if (file.profiles.length >= MAX_PROFILES) {
        throw new ChromeProfileError('limit', `at most ${MAX_PROFILES} Chrome profiles`);
      }
      file.profiles.push(name);
      return name;
    });
  }

  /** Bind a workspace to a profile; null unbinds (falls back to 'default'). */
  async setBinding(workspaceId: string, profileName: string | null): Promise<void> {
    if (!workspaceId || isUnsafeKey(workspaceId)) {
      throw new ChromeProfileError('invalid', 'invalid workspaceId');
    }
    await this.mutate((file) => {
      if (profileName === null) {
        delete file.bindings[workspaceId];
        return;
      }
      validateBrowserProfileName(profileName);
      if (!file.profiles.includes(profileName)) {
        throw new ChromeProfileError('not-found', `unknown Chrome profile "${profileName}"`);
      }
      file.bindings[workspaceId] = profileName;
    });
  }
}
