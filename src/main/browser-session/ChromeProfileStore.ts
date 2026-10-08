import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import { validateBrowserProfileName } from './ProfileManager';
import type { ChromePaneBindings } from '../../shared/chromePaneBinding';

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
//
// Schema v2 adds PANE bindings (paneId → { workspaceId, profile }): one pane's
// agent drives a Chrome of its own, so two panes in one workspace can be signed
// into two different accounts. A pane-bound profile is EXCLUSIVE — bound to no
// other pane and no workspace — which is what lets "every tab in this profile
// belongs to that pane" hold without tracking panes per tab. A v1 file loads
// unchanged (no paneBindings = none); an older build reading a v2 file simply
// drops the field.
// ---------------------------------------------------------------------------

export const DEFAULT_CHROME_PROFILE = 'default';
/**
 * Reserved profile: attach to the user's LIVE daily Chrome (Phase 3, M144
 * chrome://inspect flow). Not creatable/listable as a normal profile — the
 * menu offers it as a static row and binding it is the explicit grant.
 */
export const LIVE_CHROME_PROFILE = 'live';
const SCHEMA_VERSION = 2;
const MAX_PROFILES = 20;

/** workspaceId → profileName */
export type ChromeProfileBindings = Record<string, string>;

interface ChromeProfilesFile {
  version: number;
  profiles: string[];
  bindings: ChromeProfileBindings;
  paneBindings: ChromePaneBindings;
}

export function getChromeProfilesPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'chrome-profiles.json');
}

function emptyFile(): ChromeProfilesFile {
  return { version: SCHEMA_VERSION, profiles: [DEFAULT_CHROME_PROFILE], bindings: {}, paneBindings: {} };
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
      if (!isValidProfileName(profile)) continue;
      if (profile !== LIVE_CHROME_PROFILE && !file.profiles.includes(profile)) continue;
      // Lazy prune: a wiped session.json re-mints workspace UUIDs; bindings to
      // ids nobody knows any more are dropped on load instead of lingering.
      if (knownWorkspaceIds && !knownWorkspaceIds.has(wsId)) continue;
      file.bindings[wsId] = profile;
    }
  }
  // After the workspace bindings, so a hand-edited conflict resolves the same
  // way every load: the workspace binding wins, then the first pane listed.
  if (r.paneBindings && typeof r.paneBindings === 'object') {
    for (const [paneId, raw] of Object.entries(r.paneBindings as Record<string, unknown>)) {
      if (!paneId || isUnsafeKey(paneId)) continue;
      if (!raw || typeof raw !== 'object') continue;
      const { workspaceId, profile } = raw as Record<string, unknown>;
      if (typeof workspaceId !== 'string' || !workspaceId || isUnsafeKey(workspaceId)) continue;
      if (!isValidProfileName(profile) || !file.profiles.includes(profile)) continue;
      if (paneBindRefusal(file, paneId, profile) !== null) continue;
      if (knownWorkspaceIds && !knownWorkspaceIds.has(workspaceId)) continue;
      file.paneBindings[paneId] = { workspaceId, profile };
    }
  }
  return file;
}

/**
 * Why `profile` cannot be bound to `paneId`, or null when it can. A pane
 * profile is exclusive: never 'default' (every unbound workspace shares it),
 * never 'live' (the user's own browser is one account by definition), and
 * not bound to any workspace or to another pane. Registry membership is the
 * caller's check — the message for it differs by path.
 */
function paneBindRefusal(file: ChromeProfilesFile, paneId: string, profile: string): string | null {
  if (profile === DEFAULT_CHROME_PROFILE || profile === LIVE_CHROME_PROFILE) {
    return `the "${profile}" Chrome profile cannot be bound to a single pane; create a new profile for this pane`;
  }
  if (Object.values(file.bindings).includes(profile)) {
    return `Chrome profile "${profile}" is bound to a workspace; create a new profile for this pane`;
  }
  const holder = Object.entries(file.paneBindings).find(([id, b]) => id !== paneId && b.profile === profile);
  if (holder) {
    return `Chrome profile "${profile}" is bound to another pane; create a new profile for this pane`;
  }
  return null;
}

export class ChromeProfileError extends Error {
  readonly code: 'invalid' | 'limit' | 'not-found' | 'conflict';
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

  getPaneBindings(): ChromePaneBindings {
    const out: ChromePaneBindings = {};
    for (const [paneId, b] of Object.entries(this.ensureCache().paneBindings)) out[paneId] = { ...b };
    return out;
  }

  /**
   * The profile an automation call runs in: the calling pane's binding when it
   * was made in this same workspace, else the workspace's binding, else
   * 'default'. A pane binding from another workspace is ignored rather than
   * followed — the pane moved, and its account does not travel with it.
   */
  profileFor(workspaceId: string | undefined, paneId?: string): string {
    if (!workspaceId || isUnsafeKey(workspaceId)) return DEFAULT_CHROME_PROFILE;
    const file = this.ensureCache();
    if (paneId && !isUnsafeKey(paneId)) {
      const pane = file.paneBindings[paneId];
      if (pane && pane.workspaceId === workspaceId) return pane.profile;
    }
    return file.bindings[workspaceId] ?? DEFAULT_CHROME_PROFILE;
  }

  /** Whether any pane of this workspace has its own profile — the cheap test
   *  that decides whether a call has to find out which pane is calling. */
  hasPaneBindings(workspaceId: string | undefined): boolean {
    if (!workspaceId || isUnsafeKey(workspaceId)) return false;
    return Object.values(this.ensureCache().paneBindings).some((b) => b.workspaceId === workspaceId);
  }

  /** Whether `profile` is some pane's exclusive profile. */
  isPaneBound(profile: string): boolean {
    return Object.values(this.ensureCache().paneBindings).some((b) => b.profile === profile);
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
    if (name === LIVE_CHROME_PROFILE) {
      throw new ChromeProfileError('invalid', `"${LIVE_CHROME_PROFILE}" is reserved for live-Chrome attach`);
    }
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
      // The reserved live profile is bindable without registry membership —
      // the binding itself is the live-browser grant.
      if (profileName !== LIVE_CHROME_PROFILE && !file.profiles.includes(profileName)) {
        throw new ChromeProfileError('not-found', `unknown Chrome profile "${profileName}"`);
      }
      // A pane's profile is that pane's alone; sharing it with a whole
      // workspace would put every other pane on the same account.
      if (Object.values(file.paneBindings).some((b) => b.profile === profileName)) {
        throw new ChromeProfileError(
          'conflict',
          `Chrome profile "${profileName}" is bound to a pane; unbind it there first`,
        );
      }
      file.bindings[workspaceId] = profileName;
    });
  }

  /** Bind one pane to its own profile; null unbinds (the pane falls back to
   *  its workspace's profile). User action only, like `setBinding`. */
  async setPaneBinding(paneId: string, workspaceId: string, profileName: string | null): Promise<void> {
    if (!paneId || isUnsafeKey(paneId)) {
      throw new ChromeProfileError('invalid', 'invalid paneId');
    }
    if (!workspaceId || isUnsafeKey(workspaceId)) {
      throw new ChromeProfileError('invalid', 'invalid workspaceId');
    }
    await this.mutate((file) => {
      if (profileName === null) {
        delete file.paneBindings[paneId];
        return;
      }
      validateBrowserProfileName(profileName);
      if (profileName !== LIVE_CHROME_PROFILE && profileName !== DEFAULT_CHROME_PROFILE
        && !file.profiles.includes(profileName)) {
        throw new ChromeProfileError('not-found', `unknown Chrome profile "${profileName}"`);
      }
      const refusal = paneBindRefusal(file, paneId, profileName);
      if (refusal) throw new ChromeProfileError('conflict', refusal);
      file.paneBindings[paneId] = { workspaceId, profile: profileName };
    });
  }

  /**
   * Drop pane bindings whose pane no longer exists. `knownPaneIds` must be the
   * COMPLETE set (stashed panes included) from a restored session — a partial
   * or freshly generated tree would erase bindings the next healthy boot needs.
   * Writes only when something is actually orphaned: this runs on every
   * mirror push.
   */
  async prunePanes(knownPaneIds: ReadonlySet<string>): Promise<number> {
    const orphaned = (file: ChromeProfilesFile) =>
      Object.keys(file.paneBindings).filter((paneId) => !knownPaneIds.has(paneId));
    if (orphaned(this.ensureCache()).length === 0) return 0;
    return this.mutate((file) => {
      const gone = orphaned(file);
      for (const paneId of gone) delete file.paneBindings[paneId];
      return gone.length;
    });
  }
}
