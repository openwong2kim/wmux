import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import {
  GIT_WRITE_CONFIRM_TTL_MS, GIT_WRITE_RECEIPT_TTL_MS, GITHUB_LOGIN, PHONE_GIT_WRITE_ACTIONS,
  type GitWriteError, type GitWritePins, type GitWriteReceiptState, type PhoneGitWriteAction,
} from '../../shared/phoneGitWrite';

/**
 * Server-side state for the phone git write actions: confirm tokens, the
 * receipt store and the gh identity every network call runs as. The routes
 * live in phoneGitWriteRoutes.ts; the actions themselves in their own modules.
 */

// ── Confirm tokens ───────────────────────────────────────────────────────────

/** What a token is bound to besides its pins. Every field must match on consume. */
export interface GitWriteBinding {
  owner: string;
  sessionId: string;
  /** Canonical git common dir of the session's repository. */
  repo: string;
  action: PhoneGitWriteAction;
  login: string;
}

export type ConfirmConsumeResult =
  | { ok: true; pins: GitWritePins }
  /** Missing, expired, already used, or minted for another session, repo or action. */
  | { ok: false; error: 'confirm-required' }
  /** The gh login changed between preview and execute. */
  | { ok: false; error: 'identity-changed' }
  /** A body value differs from what the preview showed; `pins` are the preview's. */
  | { ok: false; error: 'stale'; pins: GitWritePins };

interface TokenRow { binding: GitWriteBinding; pins: GitWritePins; expiresAt: number }

const MAX_TOKENS_PER_OWNER = 16;
const MAX_TOKENS = 256;

/**
 * Single-use confirm tokens: 32 random bytes, in memory only (a restart voids
 * them all), GIT_WRITE_CONFIRM_TTL_MS from the preview.
 *
 * `consume` is synchronous from lookup to delete, so two executes racing on
 * one token cannot both pass. A token presented by a different owner is left
 * alone: it is not theirs to spend.
 */
export class GitWriteConfirmTokens {
  private readonly rows = new Map<string, TokenRow>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(binding: GitWriteBinding, pins: GitWritePins): { confirmToken: string; expiresAt: number } {
    this.sweep();
    const mine = [...this.rows].filter(([, r]) => r.binding.owner === binding.owner);
    // Oldest first; a new preview supersedes the oldest one this owner holds.
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_TOKENS_PER_OWNER + 1))) this.rows.delete(k);
    if (this.rows.size >= MAX_TOKENS) this.rows.delete(this.rows.keys().next().value as string);
    const confirmToken = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + GIT_WRITE_CONFIRM_TTL_MS;
    this.rows.set(confirmToken, { binding: { ...binding }, pins: { ...pins }, expiresAt });
    return { confirmToken, expiresAt };
  }

  /**
   * Validate and spend a token. `commit` runs only when the token is valid,
   * inside the same synchronous step, and the token is spent only if `commit`
   * returns: when it throws (the receipt could not be written) the token stays
   * valid and the error propagates. A token that fails validation is spent.
   */
  consume(confirmToken: string, binding: GitWriteBinding, bodyPins: GitWritePins, commit?: () => void): ConfirmConsumeResult {
    const row = this.rows.get(confirmToken);
    if (!row || row.binding.owner !== binding.owner) return { ok: false, error: 'confirm-required' };
    const refuse = (result: ConfirmConsumeResult) => { this.rows.delete(confirmToken); return result; };
    if (row.expiresAt <= this.now()) return refuse({ ok: false, error: 'confirm-required' });
    const b = row.binding;
    if (b.sessionId !== binding.sessionId || b.repo !== binding.repo || b.action !== binding.action) {
      return refuse({ ok: false, error: 'confirm-required' });
    }
    if (b.login !== binding.login) return refuse({ ok: false, error: 'identity-changed' });
    for (const [k, v] of Object.entries(bodyPins)) {
      if (!(k in row.pins) || row.pins[k] !== v) return refuse({ ok: false, error: 'stale', pins: row.pins });
    }
    commit?.();
    this.rows.delete(confirmToken);
    return { ok: true, pins: row.pins };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, r] of this.rows) if (r.expiresAt <= now) this.rows.delete(k);
  }
}

// ── Receipts ─────────────────────────────────────────────────────────────────

export const PHONE_GIT_WRITE_RECEIPTS_FILE = 'phone-git-write-receipts.json';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Live receipts one owner may hold; the next request is refused (429 `git-busy`), nothing is evicted. */
export const GIT_WRITE_RECEIPTS_PER_OWNER = 200;
/** Live receipts across every owner, with the same rule. */
export const GIT_WRITE_RECEIPTS_MAX = 4000;

/** Fields an action may record on its receipt: its `Done` fields, or a refusal's extras. */
export type GitWriteReceiptFields = Readonly<Record<string, string | number | boolean | null>>;

export interface GitWriteReceiptRow {
  requestId: string;
  action: PhoneGitWriteAction;
  sessionId: string;
  owner: string;
  /** Canonical git common dir the request was accepted for. */
  repo: string;
  /** pr.merge: the PR number from the path. */
  number?: number;
  /** sha256 of `gitWriteFingerprintSource`. */
  fingerprint: string;
  createdAt: number;
  state: GitWriteReceiptState;
  /** When the row went `inFlight`: recovery waits on it before it reads the outcome. */
  startedAt?: number;
  error?: GitWriteError;
  fields?: GitWriteReceiptFields;
}

/** This owner, or the whole store, holds as many live receipts as it may. */
export class GitWriteReceiptCapacityError extends Error {}

const STATES: ReadonlySet<string> = new Set<GitWriteReceiptState>(['pending', 'inFlight', 'done', 'refused', 'uncertain']);
const ACTIONS: ReadonlySet<string> = new Set<string>(PHONE_GIT_WRITE_ACTIONS);
const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;

function validRow(key: string, v: unknown): v is GitWriteReceiptRow {
  if (!/^[a-f0-9]{64}$/.test(key) || !v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!str(e.requestId, 64) || !str(e.sessionId, 256) || !str(e.owner, 300) || !str(e.repo, 4096)) return false;
  if (typeof e.action !== 'string' || !ACTIONS.has(e.action)) return false;
  if (typeof e.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(e.fingerprint) || !Number.isSafeInteger(e.createdAt)) return false;
  if (typeof e.state !== 'string' || !STATES.has(e.state)) return false;
  if (e.startedAt !== undefined && !Number.isSafeInteger(e.startedAt)) return false;
  if (e.number !== undefined && !(Number.isSafeInteger(e.number) && (e.number as number) > 0)) return false;
  if (e.error !== undefined && !str(e.error, 64)) return false;
  if (e.fields !== undefined) {
    if (!e.fields || typeof e.fields !== 'object' || Array.isArray(e.fields)) return false;
    for (const f of Object.values(e.fields as Record<string, unknown>)) {
      if (f !== null && !['string', 'number', 'boolean'].includes(typeof f)) return false;
    }
  }
  return true;
}

// ── Single writer ────────────────────────────────────────────────────────────

/** Lock files this process holds, released on exit. */
const heldLocks = new Map<string, string>();
let exitHookInstalled = false;

function bootTime(): number {
  return Math.round((Date.now() - os.uptime() * 1000) / 1000);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take `<file>.lock` for this instance. The lock names the pid, the machine's
 * boot time and a random instance id. A lock left by a process that is gone
 * (or by a previous boot) is taken over; a live one, or one this process
 * already holds, makes the store fail closed.
 */
function acquireLock(lockPath: string): string {
  const instance = `${process.pid}:${bootTime()}:${randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, instance, { flag: 'wx', mode: 0o600 });
      heldLocks.set(lockPath, instance);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once('exit', () => {
          for (const [lock, mine] of heldLocks) {
            try { if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock); } catch { /* best effort */ }
          }
        });
      }
      return instance;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (heldLocks.has(lockPath)) throw new Error('the receipt store is already open in this process');
    const [pidText, bootText] = fs.readFileSync(lockPath, 'utf8').split(':');
    const pid = Number(pidText);
    const sameBoot = Math.abs(Number(bootText) - bootTime()) <= 120;
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && sameBoot && processAlive(pid)) {
      throw new Error(`another process (pid ${pid}) holds the receipt store`);
    }
    fs.unlinkSync(lockPath);
  }
  throw new Error('could not take the receipt store lock');
}

/**
 * Durable receipts: `phone-git-write-receipts.json`, `version: 1`, 0600,
 * keyed by sha256(owner, requestId), kept GIT_WRITE_RECEIPT_TTL_MS from
 * creation. Each row stores the repository it was accepted for, so a receipt
 * stays readable after its session closed.
 *
 * NOTHING IS EVICTED INSIDE THE RETENTION WINDOW: a dropped `done` receipt
 * would let a resent request run again. A full owner (or store) refuses new
 * requests instead.
 *
 * ONE WRITER: the store takes `<file>.lock` and checks it is still its own
 * before every write; a second writer leaves it `available: false`.
 *
 * `begin` (`pending`) and `markInFlight` (about to spawn) are written
 * synchronously and durably before the caller goes on; settled outcomes are
 * coalesced onto the next tick.
 *
 * On load, an `inFlight` row reads `uncertain` (it may have landed) and a
 * `pending` row reads `refused` / `confirm-required` (nothing was spawned).
 * Neither is ever run again from here.
 *
 * FAIL CLOSED: a file that exists but cannot be read or validated leaves the
 * store unavailable, and the routes answer 503. Starting empty over it would
 * let a resent execute run a second time.
 */
export class GitWriteReceipts {
  readonly loadError?: string;
  private rows: Record<string, GitWriteReceiptRow> = {};
  private readonly file: string;
  private readonly lockPath: string;
  private instance: string | undefined;
  private lost = false;
  private saveScheduled = false;

  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.file = path.join(directory, PHONE_GIT_WRITE_RECEIPTS_FILE);
    this.lockPath = `${this.file}.lock`;
    let loadError: string | undefined;
    try {
      fs.mkdirSync(directory, { recursive: true });
      this.instance = acquireLock(this.lockPath);
      // A crash between the atomic writer's two renames leaves only `.bak`.
      const source = fs.existsSync(this.file) ? this.file : fs.existsSync(`${this.file}.bak`) ? `${this.file}.bak` : null;
      if (source) {
        if (fs.statSync(source).size > MAX_FILE_BYTES) throw new Error('the file exceeds its size limit');
        const saved = JSON.parse(fs.readFileSync(source, 'utf8')) as { version?: unknown; rows?: unknown };
        if (saved.version !== 1 || !saved.rows || typeof saved.rows !== 'object' || Array.isArray(saved.rows)) {
          throw new Error('unrecognized file shape');
        }
        let recovered = false;
        for (const [key, value] of Object.entries(saved.rows)) {
          if (!validRow(key, value)) throw new Error('invalid entry');
          if (value.state === 'inFlight') {
            this.rows[key] = { ...value, state: 'uncertain' };
            recovered = true;
          } else if (value.state === 'pending') {
            this.rows[key] = { ...value, state: 'refused', error: 'confirm-required' };
            recovered = true;
          } else this.rows[key] = value;
        }
        if (recovered) this.save();
      }
    } catch (error) {
      this.rows = {};
      loadError = error instanceof Error ? error.message : String(error);
    }
    if (loadError !== undefined) this.loadError = loadError;
  }

  /** False when the file could not be read, or another writer holds or took the store. */
  get available(): boolean { return this.loadError === undefined && !this.lost && this.instance !== undefined; }

  /** Release the lock (daemon shutdown, tests). The store is unusable afterwards. */
  close(): void {
    if (this.instance === undefined) return;
    try { if (fs.readFileSync(this.lockPath, 'utf8') === this.instance) fs.unlinkSync(this.lockPath); } catch { /* gone already */ }
    heldLocks.delete(this.lockPath);
    this.instance = undefined;
  }

  /** The store key for one request. */
  static key(owner: string, requestId: string): string {
    return createHash('sha256').update(JSON.stringify([owner, requestId])).digest('hex');
  }

  private expired(row: GitWriteReceiptRow): boolean { return row.createdAt <= this.now() - GIT_WRITE_RECEIPT_TTL_MS; }

  private dropExpired(): void {
    for (const [k, r] of Object.entries(this.rows)) if (this.expired(r)) delete this.rows[k];
  }

  private save(): void {
    let mine = false;
    try { mine = this.instance !== undefined && fs.readFileSync(this.lockPath, 'utf8') === this.instance; } catch { /* lock gone */ }
    if (!mine) {
      this.lost = true;
      throw new Error('the receipt store lock is no longer held by this instance');
    }
    this.dropExpired();
    atomicWriteJSONSync(this.file, { version: 1, rows: this.rows }, { durable: true });
  }

  private saveSoon(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setImmediate(() => {
      this.saveScheduled = false;
      // A failed write keeps the outcome in memory for this daemon's life;
      // after a restart the durable `inFlight` reads `uncertain`, which is
      // the truthful answer for an outcome that never reached disk.
      try { this.save(); } catch { /* see above */ }
    });
  }

  /** The live row, or null when there is none or it has expired. */
  find(key: string): GitWriteReceiptRow | null {
    const row = this.rows[key];
    return row && !this.expired(row) ? { ...row, ...(row.fields ? { fields: { ...row.fields } } : {}) } : null;
  }

  /**
   * Record a `pending` row durably. Throws GitWriteReceiptCapacityError when
   * this owner or the store is full (nothing is evicted), and rethrows a
   * failed write after dropping the row.
   */
  begin(key: string, row: Omit<GitWriteReceiptRow, 'createdAt' | 'state'>): void {
    if (!this.available) throw new Error('phone git write receipts unavailable');
    this.dropExpired();
    const live = Object.values(this.rows);
    if (live.filter((r) => r.owner === row.owner).length >= GIT_WRITE_RECEIPTS_PER_OWNER) {
      throw new GitWriteReceiptCapacityError('receipt quota full');
    }
    if (live.length >= GIT_WRITE_RECEIPTS_MAX) throw new GitWriteReceiptCapacityError('receipt store full');
    this.rows[key] = { ...row, createdAt: this.now(), state: 'pending' };
    try {
      this.save();
    } catch (error) {
      delete this.rows[key];
      throw error;
    }
  }

  /** `pending` → `inFlight`, durably, before the action spawns anything. Throws if the write fails. */
  markInFlight(key: string): void {
    const row = this.rows[key];
    if (!row || row.state !== 'pending') throw new Error('receipt is not pending');
    const previous = { ...row };
    this.rows[key] = { ...row, state: 'inFlight', startedAt: this.now() };
    try {
      this.save();
    } catch (error) {
      this.rows[key] = previous;
      throw error;
    }
  }

  /** Settle a row. A settled row never moves again; `uncertain` settles only to `done` or `refused`. */
  settle(key: string, outcome: { state: 'done'; fields?: GitWriteReceiptFields } | { state: 'refused'; error: GitWriteError; fields?: GitWriteReceiptFields } | { state: 'uncertain' }): void {
    const row = this.rows[key];
    if (!row || row.state === 'done' || row.state === 'refused') return;
    if (outcome.state === 'uncertain' && row.state !== 'inFlight') return;
    const next: GitWriteReceiptRow = { ...row, state: outcome.state };
    delete next.error;
    delete next.fields;
    if (outcome.state === 'refused') next.error = outcome.error;
    if (outcome.state !== 'uncertain' && outcome.fields) next.fields = { ...outcome.fields };
    this.rows[key] = next;
    this.saveSoon();
  }

  /** Every `uncertain` row, for an action's recovery pass. */
  uncertain(action: PhoneGitWriteAction): Array<{ key: string; row: GitWriteReceiptRow }> {
    return Object.entries(this.rows)
      .filter(([, r]) => r.action === action && r.state === 'uncertain' && !this.expired(r))
      .map(([key, row]) => ({ key, row: { ...row } }));
  }
}

// ── gh identity ──────────────────────────────────────────────────────────────

/** Credentials gh reads from the environment. None of them may reach a write. */
const INHERITED_GH_CREDENTIALS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

export type GhTokenRunner = (args: readonly string[], env: NodeJS.ProcessEnv) =>
  Promise<{ ok: true; stdout: string } | { ok: false; ran: boolean }>;

const runGhTokenCommand: GhTokenRunner = (args, env) => new Promise((resolve) => {
  execFile('gh', [...args], { env, timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (!error) return resolve({ ok: true, stdout: String(stdout) });
    const code = (error as NodeJS.ErrnoException).code;
    resolve({ ok: false, ran: code !== 'ENOENT' && !(error as { killed?: boolean }).killed });
  });
});

function withoutGhCredentials(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of INHERITED_GH_CREDENTIALS) delete env[name];
  return env;
}

export type GhTokenResult =
  | { ok: true; token: string }
  /** gh ran and holds no token for this login. */
  | { ok: false; reason: 'missing' }
  /** gh is not installed or did not answer. */
  | { ok: false; reason: 'unavailable' };

/**
 * `gh auth token --user <login>`, run with every inherited gh credential
 * removed: with GH_TOKEN set, gh prints that variable instead of the stored
 * token for the login, which would make the inherited account the identity.
 */
export async function ghTokenFor(login: string, run: GhTokenRunner = runGhTokenCommand, base: NodeJS.ProcessEnv = process.env): Promise<GhTokenResult> {
  if (!GITHUB_LOGIN.test(login)) return { ok: false, reason: 'missing' };
  const env = withoutGhCredentials(base);
  env.GH_HOST = 'github.com';
  env.GH_PROMPT_DISABLED = '1';
  const out = await run(['auth', 'token', '--hostname', 'github.com', '--user', login], env).catch(() => ({ ok: false as const, ran: false }));
  if (!out.ok) return { ok: false, reason: out.ran ? 'missing' : 'unavailable' };
  const token = out.stdout.trim();
  return token && !/\s/.test(token) ? { ok: true, token } : { ok: false, reason: 'missing' };
}

/**
 * The environment for one git or gh network call as `gitWriteLogin`: the
 * resolved token as GH_TOKEN, overriding whatever the daemon inherited.
 */
export function ghWriteEnv(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const env = withoutGhCredentials(base);
  env.GH_TOKEN = token;
  env.GH_HOST = 'github.com';
  env.GH_PROMPT_DISABLED = '1';
  return env;
}

// ── The bundle the server holds ──────────────────────────────────────────────

export interface PhoneGitWriteGateOptions {
  wmuxDir: string;
  now?: () => number;
  ghToken?: GhTokenRunner;
}

/** Tokens, receipts and the identity lookup, built once by the daemon. */
export class PhoneGitWriteGate {
  readonly tokens: GitWriteConfirmTokens;
  readonly receipts: GitWriteReceipts;
  private readonly ghRunner: GhTokenRunner | undefined;

  constructor(opts: PhoneGitWriteGateOptions) {
    const now = opts.now ?? Date.now;
    this.tokens = new GitWriteConfirmTokens(now);
    this.receipts = new GitWriteReceipts(opts.wmuxDir, now);
    this.ghRunner = opts.ghToken;
  }

  get available(): boolean { return this.receipts.available; }

  /** Release the receipt store's lock. */
  close(): void { this.receipts.close(); }

  identity(login: string): Promise<GhTokenResult> {
    return ghTokenFor(login, this.ghRunner);
  }
}
