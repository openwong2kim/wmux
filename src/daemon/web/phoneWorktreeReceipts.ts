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
 * FAIL CLOSED. A file that exists but cannot be read or validated leaves the
 * store `available: false`, and the daemon turns the worktree routes off; it
 * never starts empty over a file it could not read, because an empty store
 * would let a repeated request run `git worktree add` a second time.
 */

export const PHONE_WORKTREE_RECEIPTS_FILE = 'phone-worktree-receipts.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 1000;

export type PhoneWorktreeOutcome =
  | { state: 'created'; projectId: string; branch: string; base: string; cwd: string; leaf: string }
  | { state: 'refused'; error: PhoneWorktreeRefusal }
  | { state: 'unknown'; error: 'git-outcome-unknown' };

type Entry = { createdAt: number; requestId: string; sessionId: string; slug: string } &
  ({ state: 'pending' } | PhoneWorktreeOutcome);

const REFUSALS: ReadonlySet<string> = new Set<PhoneWorktreeRefusal>([
  'not-a-git-repo', 'unborn-head', 'branch-exists', 'branch-namespace-blocked', 'worktree-path-exists',
  'path-too-long', 'submodules-unsupported', 'git-filters-require-desktop', 'git-operation-in-progress',
  'git-operation-failed',
]);
const str = (v: unknown, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;

function validEntry(key: string, v: unknown): v is Entry {
  if (!/^[a-f0-9]{64}$/.test(key) || !v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isSafeInteger(e.createdAt) || !str(e.requestId, 64) || !str(e.sessionId, 256) ||
      typeof e.slug !== 'string' || !PHONE_WORKTREE_SLUG.test(e.slug)) return false;
  switch (e.state) {
    case 'pending': return true;
    case 'created': return str(e.projectId, 64) && str(e.branch, 128) && typeof e.base === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(e.base) && str(e.cwd) && str(e.leaf, 256);
    case 'refused': return typeof e.error === 'string' && REFUSALS.has(e.error);
    case 'unknown': return e.error === 'git-outcome-unknown';
    default: return false;
  }
}

export class PhoneWorktreeReceipts {
  /** False when the file could not be read or validated: the routes stay off. */
  readonly available: boolean;
  private entries: Record<string, Entry> = {};
  private readonly file: string;

  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.file = path.join(directory, PHONE_WORKTREE_RECEIPTS_FILE);
    let available = true;
    try {
      // A crash between the atomic writer's two renames leaves only `.bak`.
      const source = fs.existsSync(this.file) ? this.file : fs.existsSync(`${this.file}.bak`) ? `${this.file}.bak` : null;
      if (source) {
        if (fs.statSync(source).size > MAX_FILE_BYTES) throw new Error('phone worktree receipts exceed the size limit');
        const saved = JSON.parse(fs.readFileSync(source, 'utf8')) as { version?: unknown; entries?: unknown };
        if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) {
          throw new Error('invalid phone worktree receipts');
        }
        let recovered = false;
        for (const [key, value] of Object.entries(saved.entries)) {
          if (!validEntry(key, value)) throw new Error('invalid phone worktree receipt');
          // A job this daemon started and never finished: its outcome is unknown.
          if (value.state === 'pending') {
            this.entries[key] = { ...value, state: 'unknown', error: 'git-outcome-unknown' };
            recovered = true;
          } else this.entries[key] = value;
        }
        if (recovered) this.save(this.retained());
      }
    } catch {
      this.entries = {};
      available = false;
    }
    this.available = available;
  }

  private key(owner: string, requestId: string): string {
    return createHash('sha256').update(JSON.stringify([owner, requestId])).digest('hex');
  }

  private retained(): Record<string, Entry> {
    const cutoff = this.now() - PHONE_WORKTREE_RECEIPT_TTL_MS;
    return Object.fromEntries(Object.entries(this.entries).filter(([, e]) => e.createdAt > cutoff));
  }

  private save(entries: Record<string, Entry>): void {
    atomicWriteJSONSync(this.file, { version: 1, entries }, { durable: true });
    this.entries = entries;
  }

  /** This owner's live receipt for `requestId`, with the session and slug it was made for. */
  find(owner: string, requestId: string): { sessionId: string; slug: string; receipt: PhoneWorktreeReceipt } | null {
    const e = this.entries[this.key(owner, requestId)];
    if (!e || e.createdAt <= this.now() - PHONE_WORKTREE_RECEIPT_TTL_MS) return null;
    const receipt: Record<string, unknown> = { ...e };
    for (const internal of ['createdAt', 'sessionId', 'slug']) delete receipt[internal];
    return { sessionId: e.sessionId, slug: e.slug, receipt: receipt as unknown as PhoneWorktreeReceipt };
  }

  /** Journal the `pending` entry durably. Throws when it could not be written: nothing may run then. */
  begin(owner: string, requestId: string, sessionId: string, slug: string): void {
    if (!this.available) throw new Error('phone worktree receipts unavailable');
    const next = this.retained();
    if (Object.keys(next).length >= MAX_ENTRIES) throw new Error('phone worktree receipt capacity reached');
    next[this.key(owner, requestId)] = { createdAt: this.now(), requestId, sessionId, slug, state: 'pending' };
    this.save(next);
  }

  /**
   * Record the outcome. A failed write keeps the outcome in memory for this
   * daemon's life; after a restart the journaled `pending` reads `unknown`,
   * which is the truthful answer for an outcome that never reached disk.
   */
  settle(owner: string, requestId: string, outcome: PhoneWorktreeOutcome): void {
    const key = this.key(owner, requestId);
    const current = this.entries[key];
    if (!current) return;
    const settled = { ...this.entries, [key]: { createdAt: current.createdAt, requestId, sessionId: current.sessionId, slug: current.slug, ...outcome } };
    try { this.save(settled); } catch { this.entries = settled; }
  }
}
