import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitSyncStatus } from '../../shared/types';
import { normalizeWorktreePath } from '../../shared/workTask';

const execFileAsync = promisify(execFile);

/**
 * Sidebar git sync status — dirty count + ahead/behind vs upstream, from one
 * `git --no-optional-locks status --porcelain=v2 --branch` per repo per TTL
 * window. Same quiet-absence contract as PrStatusCache: resolves null on
 * every failure path (git missing, not a repo, timeout) and never throws.
 *
 * TTL is much shorter than the PR cache's 5 min — dirty state changes with
 * every buffer save, and the whole point of the badge is "do I have local
 * work here". `--no-optional-locks` keeps the subprocess from ever touching
 * the index lock, so it can never collide with a user-driven git operation.
 */

const TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 10_000;
/** Cache ceiling — evicts oldest entries; sized far above realistic pane counts. */
const MAX_ENTRIES = 256;

interface CacheEntry {
  value: GitSyncStatus | null;
  fetchedAt: number;
  /** In-flight fetch, shared by concurrent callers within the same window. */
  pending: Promise<GitSyncStatus | null> | null;
}

/**
 * Parse `git status --porcelain=v2 --branch` output. Exported for tests.
 *
 * Headers consumed: `# branch.ab +A -B` (present only with an upstream).
 * Every non-header line is one changed path: `1 ` (modified), `2 ` (renamed),
 * `u ` (unmerged), `? ` (untracked). Ignored entries (`! `) don't count.
 */
export function parsePorcelainV2(stdout: string): GitSyncStatus {
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
        hasUpstream = true;
      }
    } else if (/^[12u?] /.test(line)) {
      dirty++;
    }
  }
  return { dirty, ahead, behind, hasUpstream };
}

export class GitSyncStatusCache {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private now: () => number = Date.now,
    private exec: (
      cmd: string,
      args: string[],
      opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
    ) => Promise<{ stdout: string }> = execFileAsync,
  ) {}

  /**
   * Sync status for the repo containing `cwd`. Null on every failure path —
   * quiet absence is the contract (matches PrStatusCache).
   */
  async get(cwd: string): Promise<GitSyncStatus | null> {
    const key = normalizeWorktreePath(cwd);
    const entry = this.cache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending;
      if (now - entry.fetchedAt < TTL_MS) return entry.value;
    }

    const pending = this.fetch(cwd)
      .then((value) => {
        this.cache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      })
      .catch(() => {
        this.cache.set(key, { value: null, fetchedAt: this.now(), pending: null });
        return null;
      });
    this.cache.set(key, {
      value: entry?.value ?? null,
      fetchedAt: entry?.fetchedAt ?? 0,
      pending,
    });
    this.evictIfNeeded();
    return pending;
  }

  /** Drop one entry so the next poll refetches (branch switch, post-commit). */
  invalidate(cwd: string): void {
    this.cache.delete(normalizeWorktreePath(cwd));
  }

  clear(): void {
    this.cache.clear();
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetch(cwd: string): Promise<GitSyncStatus | null> {
    try {
      const { stdout } = await this.exec(
        'git',
        ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1' },
          windowsHide: true,
          // A pathological repo (thousands of untracked files) must truncate,
          // not reject — 10 MB covers ~100k paths.
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return parsePorcelainV2(stdout);
    } catch {
      // Not a repo / git missing / timeout — quiet absence.
      return null;
    }
  }
}

/** Process-wide singleton — one TTL window shared by every caller. */
export const gitSyncStatusCache = new GitSyncStatusCache();
