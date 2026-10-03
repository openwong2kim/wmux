import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import {
  PHONE_WORKTREE_RECEIPT_TTL_MS, PHONE_WORKTREE_SLUG,
  type PhoneWorktreeReceipt, type PhoneWorktreeRefusal,
} from '../../shared/phoneGitV1';

/**
 * Durable receipts for phone worktree creation (contract item 5):
 * `phone-worktree-receipts.json`, `version: 1`, 0600, keyed by
 * sha256(owner, requestId) and kept 24 h from creation.
 *
 * A `pending` entry reaches disk (`journal`, synchronous and durable) before
 * `git worktree add` starts, together with its execution record: the
 * repository, base, directory and branch the add is about to create. A
 * `pending` entry without that record is never written, so a restart simply
 * forgets a request that never touched the repository. Outcomes are written
 * on the next tick, coalesced across requests.
 *
 * FAIL CLOSED. A file that exists but cannot be read or validated leaves the
 * store `available: false`, and the daemon turns the worktree routes off; it
 * never starts empty over a file it could not read, because an empty store
 * would let a repeated request run `git worktree add` a second time.
 */

export const PHONE_WORKTREE_RECEIPTS_FILE = 'phone-worktree-receipts.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Receipts one caller (a device, or the operator token) may hold at once. */
export const PHONE_WORKTREE_RECEIPTS_PER_OWNER = 100;
const MAX_ENTRIES = 2000;

export type PhoneWorktreeOutcome =
  | { state: 'created'; projectId: string; branch: string; base: string; cwd: string; leaf: string }
  | { state: 'refused'; error: PhoneWorktreeRefusal }
  | { state: 'unknown'; error: 'git-outcome-unknown'; retryAfterMs?: number };

/**
 * What a request is doing to the repository, written durably before it does
 * it. `add`: the branch and the directory did not exist and `git worktree add`
 * is about to create them from `base`. `remove`: recovery decided the
 * half-made checkout at `dir` is this request's own and is about to remove it.
 * Recovery acts only on what this record says the request created.
 */
export interface PhoneWorktreeExec {
  phase: 'add' | 'remove';
  /** Canonical git common dir of the repository. */
  repo: string;
  dir: string;
  branch: string;
  base: string;
}

type Entry = { createdAt: number; requestId: string; sessionId: string; slug: string; owner?: string; exec?: PhoneWorktreeExec } &
  ({ state: 'pending' } | PhoneWorktreeOutcome);

/** Every receipt this owner may hold is still in flight. */
export class ReceiptCapacityError extends Error {}

const REFUSALS: ReadonlySet<string> = new Set<PhoneWorktreeRefusal>([
  'not-a-git-repo', 'unborn-head', 'branch-exists', 'branch-namespace-blocked', 'worktree-path-exists',
  'path-too-long', 'submodules-unsupported', 'git-filters-require-desktop', 'git-operation-in-progress',
  'git-operation-failed', 'worktree-path-unsafe', 'git-version-unsupported',
]);
const str = (v: unknown, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function validExec(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return (x.phase === 'add' || x.phase === 'remove') && str(x.repo) && str(x.dir) && str(x.branch, 128) &&
    typeof x.base === 'string' && OID.test(x.base);
}

function validEntry(key: string, v: unknown): v is Entry {
  if (!/^[a-f0-9]{64}$/.test(key) || !v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isSafeInteger(e.createdAt) || !str(e.requestId, 64) || !str(e.sessionId, 256) || (e.owner !== undefined && !str(e.owner, 300)) ||
      typeof e.slug !== 'string' || !PHONE_WORKTREE_SLUG.test(e.slug)) return false;
  // Only a request still running, or whose outcome is unknown, carries its execution record.
  if (e.exec !== undefined && ((e.state !== 'pending' && e.state !== 'unknown') || !validExec(e.exec))) return false;
  switch (e.state) {
    case 'pending': return true;
    case 'created': return str(e.projectId, 64) && str(e.branch, 128) && typeof e.base === 'string' &&
      OID.test(e.base) && str(e.cwd) && str(e.leaf, 256);
    case 'refused': return typeof e.error === 'string' && REFUSALS.has(e.error);
    case 'unknown': return e.error === 'git-outcome-unknown' && (e.retryAfterMs === undefined || (Number.isSafeInteger(e.retryAfterMs) && (e.retryAfterMs as number) > 0));
    default: return false;
  }
}

export class PhoneWorktreeReceipts {
  /** False when the file could not be read or validated: the routes stay off. */
  readonly available: boolean;
  /** Why the store is unavailable, for the daemon log. */
  readonly loadError?: string;
  private entries: Record<string, Entry> = {};
  private readonly file: string;
  private saveScheduled = false;

  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.file = path.join(directory, PHONE_WORKTREE_RECEIPTS_FILE);
    let loadError: string | undefined;
    try {
      // A crash between the atomic writer's two renames leaves only `.bak`.
      const source = fs.existsSync(this.file) ? this.file : fs.existsSync(`${this.file}.bak`) ? `${this.file}.bak` : null;
      if (source) {
        if (fs.statSync(source).size > MAX_FILE_BYTES) throw new Error('the file exceeds its size limit');
        const saved = JSON.parse(fs.readFileSync(source, 'utf8')) as { version?: unknown; entries?: unknown };
        if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) {
          throw new Error('unrecognized file shape');
        }
        let recovered = false;
        for (const [key, value] of Object.entries(saved.entries)) {
          if (!validEntry(key, value)) throw new Error('invalid entry');
          // A job this daemon journaled and never finished: its outcome is unknown.
          if (value.state === 'pending') {
            this.entries[key] = { ...value, state: 'unknown', error: 'git-outcome-unknown' };
            recovered = true;
          } else this.entries[key] = value;
        }
        if (recovered) this.save();
      }
    } catch (error) {
      this.entries = {};
      loadError = error instanceof Error ? error.message : String(error);
    }
    this.available = loadError === undefined;
    if (loadError !== undefined) this.loadError = loadError;
  }

  private key(owner: string, requestId: string): string {
    return createHash('sha256').update(JSON.stringify([owner, requestId])).digest('hex');
  }

  private expired(e: Entry): boolean { return e.createdAt <= this.now() - PHONE_WORKTREE_RECEIPT_TTL_MS; }

  private dropExpired(): void {
    for (const [k, e] of Object.entries(this.entries)) if (this.expired(e)) delete this.entries[k];
  }

  private save(): void {
    this.dropExpired();
    // A request still in its pre-checks has written nothing: it stays in memory only.
    const entries = Object.fromEntries(Object.entries(this.entries).filter(([, e]) => e.state !== 'pending' || e.exec));
    atomicWriteJSONSync(this.file, { version: 1, entries }, { durable: true });
  }

  /** Outcomes are written on the next tick; many settles coalesce into one write. */
  private saveSoon(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setImmediate(() => {
      this.saveScheduled = false;
      // A failed write keeps the outcome in memory for this daemon's life;
      // after a restart the journaled `pending` reads `unknown`, the truthful
      // answer for an outcome that never reached disk.
      try { this.save(); } catch { /* see above */ }
    });
  }

  /** This owner's live receipt for `requestId`, with the session and slug it was made for. */
  find(owner: string, requestId: string): { sessionId: string; slug: string; receipt: PhoneWorktreeReceipt } | null {
    const e = this.entries[this.key(owner, requestId)];
    if (!e || this.expired(e)) return null;
    const receipt: Record<string, unknown> = { ...e };
    for (const internal of ['createdAt', 'sessionId', 'slug', 'owner', 'exec']) delete receipt[internal];
    return { sessionId: e.sessionId, slug: e.slug, receipt: receipt as unknown as PhoneWorktreeReceipt };
  }

  /**
   * Record a `pending` request in memory, making room within this owner's
   * quota by dropping their oldest `created` or `refused` receipts (an
   * `unknown` one is kept: a repeat of it still has to recover). Throws
   * `ReceiptCapacityError` when there is no such receipt left to drop.
   */
  begin(owner: string, requestId: string, sessionId: string, slug: string): void {
    if (!this.available) throw new Error('phone worktree receipts unavailable');
    this.dropExpired();
    const finishedOldestFirst = (rows: Array<[string, Entry]>) =>
      rows.filter(([, e]) => e.state === 'created' || e.state === 'refused').sort(([, a], [, b]) => a.createdAt - b.createdAt);
    const mine = Object.entries(this.entries).filter(([, e]) => e.owner === owner);
    for (const [k] of finishedOldestFirst(mine).slice(0, Math.max(0, mine.length - PHONE_WORKTREE_RECEIPTS_PER_OWNER + 1))) {
      delete this.entries[k];
    }
    if (Object.values(this.entries).filter((e) => e.owner === owner).length >= PHONE_WORKTREE_RECEIPTS_PER_OWNER) {
      throw new ReceiptCapacityError('receipt quota full');
    }
    const all = Object.entries(this.entries);
    for (const [k] of finishedOldestFirst(all).slice(0, Math.max(0, all.length - MAX_ENTRIES + 1))) delete this.entries[k];
    if (Object.keys(this.entries).length >= MAX_ENTRIES) throw new ReceiptCapacityError('receipt store full');
    this.entries[this.key(owner, requestId)] = { createdAt: this.now(), requestId, sessionId, slug, owner, state: 'pending' };
  }

  /** Put an `unknown` receipt back to `pending` for a recovery run, keeping its execution record. */
  reopen(owner: string, requestId: string): void {
    const e = this.entries[this.key(owner, requestId)];
    if (e) {
      this.entries[this.key(owner, requestId)] = {
        createdAt: e.createdAt, requestId, sessionId: e.sessionId, slug: e.slug, owner, ...(e.exec ? { exec: e.exec } : {}), state: 'pending',
      };
    }
  }

  /** The execution record of this request, if it reached one. */
  exec(owner: string, requestId: string): PhoneWorktreeExec | undefined {
    return this.entries[this.key(owner, requestId)]?.exec;
  }

  /**
   * Durably record what this `pending` request is about to do, before it does
   * it. Throws when it could not be written; the request then does nothing.
   */
  journal(owner: string, requestId: string, exec: PhoneWorktreeExec): void {
    const e = this.entries[this.key(owner, requestId)];
    if (!e || e.state !== 'pending') throw new Error('no pending request');
    const previous = e.exec;
    e.exec = exec;
    try { this.save(); } catch (error) {
      if (previous) e.exec = previous; else delete e.exec;
      throw error;
    }
  }

  /** Record the outcome (written on the next tick). Only an `unknown` one keeps the execution record. */
  settle(owner: string, requestId: string, outcome: PhoneWorktreeOutcome): void {
    const key = this.key(owner, requestId);
    const current = this.entries[key];
    if (!current) return;
    const exec = outcome.state === 'unknown' && current.exec ? { exec: current.exec } : {};
    this.entries[key] = { createdAt: current.createdAt, requestId, sessionId: current.sessionId, slug: current.slug, owner, ...exec, ...outcome };
    this.saveSoon();
  }

  /** Drop a request that never reached `git worktree add` and could not be recorded. */
  forget(owner: string, requestId: string): void { delete this.entries[this.key(owner, requestId)]; }

  /** Resolves after pending writes have run (tests, shutdown). */
  flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
}
