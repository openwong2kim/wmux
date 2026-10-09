import fs from 'node:fs';
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
 * `consume` is synchronous and deletes the row before it compares anything, so
 * two executes racing on one token cannot both pass. A token presented by a
 * different owner is left alone: it is not theirs to spend.
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

  consume(confirmToken: string, binding: GitWriteBinding, bodyPins: GitWritePins): ConfirmConsumeResult {
    const row = this.rows.get(confirmToken);
    if (!row || row.binding.owner !== binding.owner) return { ok: false, error: 'confirm-required' };
    this.rows.delete(confirmToken);
    if (row.expiresAt <= this.now()) return { ok: false, error: 'confirm-required' };
    const b = row.binding;
    if (b.sessionId !== binding.sessionId || b.repo !== binding.repo || b.action !== binding.action) {
      return { ok: false, error: 'confirm-required' };
    }
    if (b.login !== binding.login) return { ok: false, error: 'identity-changed' };
    for (const [k, v] of Object.entries(bodyPins)) {
      if (!(k in row.pins) || row.pins[k] !== v) return { ok: false, error: 'stale', pins: row.pins };
    }
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
export const GIT_WRITE_RECEIPTS_PER_OWNER = 200;
const MAX_ENTRIES = 4000;

/** Fields an action may record on its receipt: its `Done` fields, or a refusal's extras. */
export type GitWriteReceiptFields = Readonly<Record<string, string | number | boolean | null>>;

export interface GitWriteReceiptRow {
  requestId: string;
  action: PhoneGitWriteAction;
  sessionId: string;
  owner: string;
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

/** Every receipt this owner may hold is still unsettled. */
export class GitWriteReceiptCapacityError extends Error {}

const STATES: ReadonlySet<string> = new Set<GitWriteReceiptState>(['pending', 'inFlight', 'done', 'refused', 'uncertain']);
const ACTIONS: ReadonlySet<string> = new Set<string>(PHONE_GIT_WRITE_ACTIONS);
const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;

function validRow(key: string, v: unknown): v is GitWriteReceiptRow {
  if (!/^[a-f0-9]{64}$/.test(key) || !v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!str(e.requestId, 64) || !str(e.sessionId, 256) || !str(e.owner, 300) || typeof e.action !== 'string' || !ACTIONS.has(e.action)) return false;
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

/**
 * Durable receipts: `phone-git-write-receipts.json`, `version: 1`, 0600,
 * keyed by sha256(owner, repo, requestId), kept GIT_WRITE_RECEIPT_TTL_MS from
 * creation.
 *
 * `begin` (token consumed, `pending`) and `markInFlight` (about to spawn) are
 * written synchronously and durably before the caller goes on; settled
 * outcomes are coalesced onto the next tick.
 *
 * On load, an `inFlight` row reads `uncertain` (it may have landed) and a
 * `pending` row reads `refused` / `confirm-required` (nothing was spawned).
 * Neither is ever run again from here.
 *
 * FAIL CLOSED: a file that exists but cannot be read or validated leaves the
 * store `available: false`, and the routes answer 503. Starting empty over
 * it would let a resent execute run a second time.
 */
export class GitWriteReceipts {
  readonly available: boolean;
  readonly loadError?: string;
  private rows: Record<string, GitWriteReceiptRow> = {};
  private readonly file: string;
  private saveScheduled = false;

  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.file = path.join(directory, PHONE_GIT_WRITE_RECEIPTS_FILE);
    let loadError: string | undefined;
    try {
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
    this.available = loadError === undefined;
    if (loadError !== undefined) this.loadError = loadError;
  }

  /** The store key for one request. Exposed so an action can settle its own row. */
  static key(owner: string, repo: string, requestId: string): string {
    return createHash('sha256').update(JSON.stringify([owner, repo, requestId])).digest('hex');
  }

  private expired(row: GitWriteReceiptRow): boolean { return row.createdAt <= this.now() - GIT_WRITE_RECEIPT_TTL_MS; }

  private dropExpired(): void {
    for (const [k, r] of Object.entries(this.rows)) if (this.expired(r)) delete this.rows[k];
  }

  private save(): void {
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
   * Record a `pending` row durably. Makes room in this owner's quota by
   * dropping their oldest settled rows (`done` / `refused`); an unsettled or
   * `uncertain` row is kept. Throws GitWriteReceiptCapacityError when nothing
   * can be dropped, and rethrows a failed write after dropping the row.
   */
  begin(key: string, row: Omit<GitWriteReceiptRow, 'createdAt' | 'state'>): void {
    if (!this.available) throw new Error('phone git write receipts unavailable');
    this.dropExpired();
    const settled = (rows: Array<[string, GitWriteReceiptRow]>) =>
      rows.filter(([, r]) => r.state === 'done' || r.state === 'refused').sort(([, a], [, b]) => a.createdAt - b.createdAt);
    const mine = Object.entries(this.rows).filter(([, r]) => r.owner === row.owner);
    for (const [k] of settled(mine).slice(0, Math.max(0, mine.length - GIT_WRITE_RECEIPTS_PER_OWNER + 1))) delete this.rows[k];
    if (Object.values(this.rows).filter((r) => r.owner === row.owner).length >= GIT_WRITE_RECEIPTS_PER_OWNER) {
      throw new GitWriteReceiptCapacityError('receipt quota full');
    }
    const all = Object.entries(this.rows);
    for (const [k] of settled(all).slice(0, Math.max(0, all.length - MAX_ENTRIES + 1))) delete this.rows[k];
    if (Object.keys(this.rows).length >= MAX_ENTRIES) throw new GitWriteReceiptCapacityError('receipt store full');
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

  identity(login: string): Promise<GhTokenResult> {
    return ghTokenFor(login, this.ghRunner);
  }
}
