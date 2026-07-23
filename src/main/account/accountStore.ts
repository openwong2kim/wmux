// ─── Multi-Account Management — main-owned account registry + bindings ───────
//
// First-class "account" = a named config-directory pointer. wmux stores ONLY
// names + directory paths here; it never reads or writes the OAuth token itself
// (that lives inside the config dir, owned by the vendor CLI). One JSON file in
// the wmux data dir (`accounts.json`), WMUX_DATA_SUFFIX-isolated, mirroring the
// deckScheduleStore data-dir-file pattern.
//
// Design (SSOT: plans/multi-account-management-FINAL-2026-07-14.md):
//   - Store is MAIN-owned so spawn-env resolution is fully main-resolved; the
//     renderer only reads snapshots / requests mutations via IPC.
//   - ALL mutations funnel through ONE serialized async write queue. Plain
//     atomicWriteJSON is last-writer-wins with no lock: two overlapping
//     read-modify-write mutations would drop one. The queue makes each mutation
//     load→mutate→persist atomically w.r.t. other mutations (eng-review P1).
//   - An in-memory cache is kept so the SPAWN HOT PATH does a sync in-memory
//     read, never a disk read (eng-review P1).
//   - configDir is canonicalized to its PHYSICAL filesystem identity at
//     registration (resolve junction/symlink/UNC/8.3/case aliases) and
//     duplicates are rejected by canonical identity, so two "accounts" can never
//     resolve to one credential directory (3-way review, Codex P1).
//   - Bindings for unknown workspaceIds are lazily pruned on load.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export type Vendor = 'claude' | 'codex';

export interface Account {
  id: string;
  /** Human label the user recognizes (e.g. "Work Max", "Personal"). */
  name: string;
  vendor: Vendor;
  /** Canonical absolute path to the vendor config dir (CLAUDE_CONFIG_DIR /
   *  CODEX_HOME target). Physical identity — resolved at registration. */
  configDir: string;
  createdAt: number;
}

/** Per-workspace, per-vendor account binding. A workspace may bind one claude
 *  account AND one codex account simultaneously. */
export type Bindings = Record<string, Partial<Record<Vendor, string>>>;

interface AccountsFile {
  version: number;
  accounts: Account[];
  bindings: Bindings;
}

const SCHEMA_VERSION = 1;
const MAX_ACCOUNTS = 50;
const MAX_NAME_CHARS = 120;

/** Env var each vendor reads to select its config dir. */
const VENDOR_ENV_KEY: Record<Vendor, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

export function getAccountsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'accounts.json');
}

function isVendor(v: unknown): v is Vendor {
  return v === 'claude' || v === 'codex';
}

/** Keys that would pollute Object.prototype if used to index a plain object.
 *  workspaceId / accountId flow from renderer IPC, so they are rejected before
 *  ever indexing bindings (Codex review P1: prototype pollution). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

function emptyFile(): AccountsFile {
  return { version: SCHEMA_VERSION, accounts: [], bindings: {} };
}

/**
 * Canonicalize a configDir to its physical filesystem identity. Resolves
 * symlinks/junctions/8.3-short/case aliases via realpathSync.native so two
 * lexically-different paths that point at the same directory dedupe correctly.
 * Falls back to path.resolve when the dir does not yet exist on disk (caller
 * created it moments earlier, or a bound dir was deleted) — callers must still
 * guard existence at spawn time.
 */
export function canonicalizeConfigDir(input: string): string {
  const resolved = path.resolve(input);
  // .native uses the OS realpath: on Windows it collapses 8.3 + case aliases,
  // on POSIX it resolves symlinks — exactly the aliases lexical normalize misses.
  // We REQUIRE it to succeed (see addAccount): a lexical fallback would let two
  // Windows case-spellings register as distinct accounts that later resolve to
  // one credential dir (Codex review P1). Throws when the dir is missing/
  // inaccessible; addAccount surfaces that as an 'invalid' AccountError.
  return fs.realpathSync.native(resolved);
}

/** True when `dir` resolves to an accessible DIRECTORY on disk (not a file,
 *  not a dangling link). Used at spawn time before injecting the overlay. */
function isAccessibleDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.name !== 'string' || !o.name.trim()) return null;
  if (!isVendor(o.vendor)) return null;
  if (typeof o.configDir !== 'string' || !o.configDir) return null;
  return {
    id: o.id,
    name: o.name.slice(0, MAX_NAME_CHARS),
    vendor: o.vendor,
    configDir: o.configDir,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
}

/** Parse + prune a raw file into a valid AccountsFile. Unknown-workspace
 *  bindings and bindings pointing at unknown accountIds are dropped. */
function sanitizeFile(raw: unknown, knownWorkspaceIds?: ReadonlySet<string>): AccountsFile {
  if (!raw || typeof raw !== 'object') return emptyFile();
  const o = raw as Record<string, unknown>;
  const accounts: Account[] = Array.isArray(o.accounts)
    ? o.accounts.map(sanitizeAccount).filter((a): a is Account => a !== null)
    : [];
  // Map id → vendor so a binding can be dropped when its account is gone OR when
  // the account's vendor doesn't match the slot (a recovered/hand-edited file
  // must never route a claude dir through CODEX_HOME — Codex review P2).
  const accountVendor = new Map(accounts.map((a) => [a.id, a.vendor] as const));

  const bindings: Bindings = Object.create(null) as Bindings;
  const rawBindings = o.bindings;
  if (rawBindings && typeof rawBindings === 'object') {
    for (const [wsId, perVendor] of Object.entries(rawBindings as Record<string, unknown>)) {
      if (isUnsafeKey(wsId)) continue; // prototype-pollution guard
      // Lazy prune: drop bindings for workspaces that no longer exist.
      if (knownWorkspaceIds && !knownWorkspaceIds.has(wsId)) continue;
      if (!perVendor || typeof perVendor !== 'object') continue;
      const entry: Partial<Record<Vendor, string>> = {};
      for (const vendor of ['claude', 'codex'] as const) {
        const accId = (perVendor as Record<string, unknown>)[vendor];
        // Keep only a reference whose account exists AND matches this vendor slot.
        if (typeof accId === 'string' && accountVendor.get(accId) === vendor) entry[vendor] = accId;
      }
      if (Object.keys(entry).length > 0) bindings[wsId] = entry;
    }
  }
  return { version: SCHEMA_VERSION, accounts, bindings };
}

export class AccountError extends Error {
  readonly code: 'duplicate-dir' | 'not-found' | 'limit' | 'invalid';
  constructor(code: AccountError['code'], message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

/**
 * Owns accounts.json. One instance per process. Reads are served from an
 * in-memory cache (sync, for the spawn hot path); writes are serialized through
 * a single promise chain so overlapping read-modify-write mutations never race.
 */
export class AccountStore {
  private readonly filePath: string;
  private cache: AccountsFile | null = null;
  /** Serialized write chain — every mutation awaits the previous one. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dir?: string) {
    this.filePath = getAccountsPath(dir);
  }

  /** Load (or reload) from disk into the cache. A missing/corrupt file loads as
   *  empty (fail open — a torn store must never brick spawning). */
  load(knownWorkspaceIds?: ReadonlySet<string>): AccountsFile {
    let raw: unknown = null;
    try {
      raw = atomicReadJSONSync<unknown>(this.filePath);
    } catch {
      raw = null;
    }
    this.cache = sanitizeFile(raw, knownWorkspaceIds);
    return this.cache;
  }

  private ensureCache(): AccountsFile {
    return this.cache ?? this.load();
  }

  // ── Sync reads (cache-backed; safe on the spawn hot path) ──────────────────

  listAccounts(): Account[] {
    return [...this.ensureCache().accounts];
  }

  getAccount(id: string): Account | undefined {
    return this.ensureCache().accounts.find((a) => a.id === id);
  }

  getBinding(workspaceId: string, vendor: Vendor): string | undefined {
    return this.ensureCache().bindings[workspaceId]?.[vendor];
  }

  /** Full bindings snapshot (deep-copied) for the renderer. */
  getBindings(): Bindings {
    const out: Bindings = {};
    for (const [wsId, perVendor] of Object.entries(this.ensureCache().bindings)) {
      out[wsId] = { ...perVendor };
    }
    return out;
  }

  /**
   * Resolve the account env overlay for a spawn — SYNC, cache-only, hot path.
   * Returns `{ CLAUDE_CONFIG_DIR }` / `{ CODEX_HOME }` when the workspace binds
   * an account for `vendor` whose configDir still exists on disk; otherwise an
   * empty object (fall back to the default credential). When a binding exists
   * but its dir is gone, reports it via `onMissing` so the caller can warn —
   * otherwise the CLI would silently create a fresh empty logged-out config.
   */
  resolveAccountEnv(
    workspaceId: string,
    vendor: Vendor,
    onMissing?: (account: Account) => void,
  ): Record<string, string> {
    const accountId = this.getBinding(workspaceId, vendor);
    if (!accountId) return {};
    const account = this.getAccount(accountId);
    if (!account) return {};
    // Must be an accessible DIRECTORY — a regular file, dangling link, or
    // unreadable path is treated as missing (fall back to default credential)
    // rather than injected into the child (Codex review P2).
    if (!isAccessibleDir(account.configDir)) {
      onMissing?.(account);
      return {};
    }
    return { [VENDOR_ENV_KEY[vendor]]: account.configDir };
  }

  /**
   * Resolve the COMBINED account env for a spawn keyed only on workspaceId.
   * The spawn site usually doesn't know which vendor CLI the pane will run
   * (a shell where the user may type `claude` OR `codex`), so we inject BOTH
   * CLAUDE_CONFIG_DIR (if a claude account is bound) and CODEX_HOME (if a codex
   * account is bound). They don't interfere — each CLI reads only its own var.
   */
  resolveWorkspaceAccountEnv(
    workspaceId: string,
    onMissing?: (account: Account) => void,
  ): Record<string, string> {
    return {
      ...this.resolveAccountEnv(workspaceId, 'claude', onMissing),
      ...this.resolveAccountEnv(workspaceId, 'codex', onMissing),
    };
  }

  // ── Serialized mutations ───────────────────────────────────────────────────

  /**
   * Run `fn` against the freshly-loaded file inside the serialized write chain,
   * then persist + refresh the cache atomically w.r.t. other mutations. `fn`
   * may throw (e.g. AccountError) to abort without writing.
   */
  private mutate<T>(fn: (file: AccountsFile) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      // Reload from disk into a DETACHED copy (does not touch this.cache) so a
      // failed write leaves the published cache — and thus spawn routing —
      // exactly as it was committed (Codex review P2). Publish only after the
      // durable write succeeds.
      let raw: unknown = null;
      try { raw = atomicReadJSONSync<unknown>(this.filePath); } catch { raw = null; }
      const file = sanitizeFile(raw);
      const result = fn(file);
      await atomicWriteJSON(this.filePath, file, { durable: true });
      this.cache = file;
      return result;
    });
    // Keep the chain alive even if this mutation rejected.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async addAccount(input: { name: string; vendor: Vendor; configDir: string }): Promise<Account> {
    const name = input.name.trim();
    if (!name) throw new AccountError('invalid', 'account name is required');
    if (!isVendor(input.vendor)) throw new AccountError('invalid', 'invalid vendor');
    // Require an existing, canonicalizable directory: a lexical fallback would
    // let two case/8.3/UNC spellings register as distinct accounts that later
    // resolve to one credential dir (Codex review P1).
    let canonical: string;
    try {
      canonical = canonicalizeConfigDir(input.configDir);
    } catch {
      throw new AccountError('invalid', `config directory does not exist or is inaccessible: ${input.configDir}`);
    }
    if (!isAccessibleDir(canonical)) {
      throw new AccountError('invalid', `config directory is not a directory: ${input.configDir}`);
    }
    return this.mutate((file) => {
      if (file.accounts.length >= MAX_ACCOUNTS) {
        throw new AccountError('limit', `account limit (${MAX_ACCOUNTS}) reached`);
      }
      // Dedup by canonical physical identity — NOT by the string the user typed.
      if (file.accounts.some((a) => a.configDir === canonical)) {
        throw new AccountError('duplicate-dir', `config directory already registered: ${canonical}`);
      }
      const account: Account = {
        id: randomUUID(),
        name: name.slice(0, MAX_NAME_CHARS),
        vendor: input.vendor,
        configDir: canonical,
        createdAt: Date.now(),
      };
      file.accounts.push(account);
      return account;
    });
  }

  async renameAccount(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new AccountError('invalid', 'account name is required');
    await this.mutate((file) => {
      const account = file.accounts.find((a) => a.id === id);
      if (!account) throw new AccountError('not-found', `account not found: ${id}`);
      account.name = trimmed.slice(0, MAX_NAME_CHARS);
    });
  }

  /**
   * Unregister an account (NEVER deletes the directory on disk). Returns the
   * list of workspaceIds whose bindings referenced it — the caller surfaces the
   * "these workspaces fall back to default" warning. Their bindings are cleared
   * so no dangling accountId is ever left behind.
   */
  async removeAccount(id: string): Promise<string[]> {
    return this.mutate((file) => {
      const idx = file.accounts.findIndex((a) => a.id === id);
      if (idx < 0) throw new AccountError('not-found', `account not found: ${id}`);
      file.accounts.splice(idx, 1);
      const affected: string[] = [];
      for (const [wsId, perVendor] of Object.entries(file.bindings)) {
        let touched = false;
        for (const vendor of ['claude', 'codex'] as const) {
          if (perVendor[vendor] === id) {
            delete perVendor[vendor];
            touched = true;
          }
        }
        if (touched) affected.push(wsId);
        if (Object.keys(perVendor).length === 0) delete file.bindings[wsId];
      }
      return affected;
    });
  }

  /** Bind (or, with accountId undefined, unbind) a vendor account to a
   *  workspace. Validates the account exists and matches the vendor. */
  async setBinding(workspaceId: string, vendor: Vendor, accountId: string | undefined): Promise<void> {
    if (!workspaceId) throw new AccountError('invalid', 'workspaceId is required');
    if (isUnsafeKey(workspaceId)) throw new AccountError('invalid', 'invalid workspaceId');
    await this.mutate((file) => {
      if (accountId !== undefined) {
        const account = file.accounts.find((a) => a.id === accountId);
        if (!account) throw new AccountError('not-found', `account not found: ${accountId}`);
        if (account.vendor !== vendor) {
          throw new AccountError('invalid', `account ${accountId} is ${account.vendor}, not ${vendor}`);
        }
        const entry = file.bindings[workspaceId] ?? {};
        entry[vendor] = accountId;
        file.bindings[workspaceId] = entry;
      } else {
        const entry = file.bindings[workspaceId];
        if (entry) {
          delete entry[vendor];
          if (Object.keys(entry).length === 0) delete file.bindings[workspaceId];
        }
      }
    });
  }

  /** Drop bindings for workspaces no longer present (sweep on workspace
   *  deletion). Returns the count pruned. */
  async pruneBindings(knownWorkspaceIds: ReadonlySet<string>): Promise<number> {
    return this.mutate((file) => {
      let pruned = 0;
      for (const wsId of Object.keys(file.bindings)) {
        if (!knownWorkspaceIds.has(wsId)) {
          delete file.bindings[wsId];
          pruned++;
        }
      }
      return pruned;
    });
  }
}

export const ACCOUNT_LIMITS = { MAX_ACCOUNTS, MAX_NAME_CHARS } as const;
export const VENDOR_ENV_KEYS = VENDOR_ENV_KEY;

// ── Process-wide singleton (main process) ────────────────────────────────────
// The spawn hot path resolves account env through this shared instance so every
// launch path (PTYManager, daemon handler, SDK adapter, A2A worker — M0) reads
// one main-owned store with one cache + one serialized write queue.
let singleton: AccountStore | null = null;

export function getAccountStore(): AccountStore {
  if (!singleton) {
    singleton = new AccountStore();
    singleton.load();
  }
  return singleton;
}

/** Test-only reset so suites don't leak a singleton across the real data dir. */
export function __resetAccountStoreForTests(): void {
  singleton = null;
}
