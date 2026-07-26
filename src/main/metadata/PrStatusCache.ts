import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrStatus } from '../../shared/types';
import {
  paneCommandIdentity,
  preparePaneCommand,
  hostCommandTarget,
  type PaneCommandTarget,
} from '../git/paneCommand';

const execFileAsync = promisify(execFile);

/**
 * X1 — PR status for the current branch via the GitHub CLI.
 *
 * Frozen contract (schema-freeze §2): `pr` comes from a main-process gh
 * cache with a 5 min TTL, and is silently absent when `gh` is not installed
 * or the branch has no PR. Never throws; never prompts (GH_PROMPT_DISABLED).
 *
 * Cache key is `location identity + branch` — the same branch checked out in
 * two repos, worktrees, domains, or WSL distributions resolves independently,
 * while repeated lookups from the metadata poll collapse onto one gh
 * subprocess per TTL window.
 */

/**
 * Cache key = location identity + NUL + branch.
 *
 * The identity is computed by `paneCommandIdentity` → `locationIdentity`
 * (shared/sessionLocation.ts). That shared identity helper separates
 * host/msys/wsl (and WSL distros) and, for host
 * paths, folds separator, duplicate-slash, trailing-slash and — on the
 * case-insensitive filesystems — case variance. That folding is what makes a
 * PR-creation `invalidate(worktreePath, branch)` hit the entry the metadata
 * poll's `get(target, branch)` created; without it `C:\a` vs `c:/a/` miss and
 * the stale 5-min entry survives (CX8). Nothing is normalized here — a second
 * normalizer is exactly how the two spellings drifted apart before.
 *
 * The raw location is still what `fetch` runs gh in.
 */
function cacheKey(target: PaneCommandTarget, branch: string): string {
  return `${paneCommandIdentity(target)}\0${branch}`;
}

const TTL_MS = 5 * 60 * 1000;
const GH_TIMEOUT_MS = 10_000;
/** Cache ceiling — evicts oldest entries; sized far above realistic pane counts. */
const MAX_ENTRIES = 256;

interface CacheEntry {
  value: PrStatus | null;
  fetchedAt: number;
  /** In-flight fetch, shared by concurrent callers within the same window. */
  pending: Promise<PrStatus | null> | null;
}

interface GhPrViewJson {
  number?: number;
  state?: string;       // "OPEN" | "MERGED" | "CLOSED"
  isDraft?: boolean;
  url?: string;
  statusCheckRollup?: Array<{
    status?: string;     // "COMPLETED" | "IN_PROGRESS" | "QUEUED" | ...
    conclusion?: string; // "SUCCESS" | "FAILURE" | "NEUTRAL" | ...
    state?: string;      // StatusContext variant: "SUCCESS" | "FAILURE" | "PENDING"
  }> | null;
}

/** Map a gh JSON payload onto the frozen PrStatus shape. Exported for tests. */
export function mapGhPrView(json: GhPrViewJson): PrStatus | null {
  if (typeof json.number !== 'number' || typeof json.url !== 'string') return null;
  const rawState = (json.state ?? '').toUpperCase();
  const state: PrStatus['state'] =
    rawState === 'MERGED' ? 'merged'
    : rawState === 'CLOSED' ? 'closed'
    : json.isDraft ? 'draft'
    : 'open';

  let checks: PrStatus['checks'] = null;
  const rollup = json.statusCheckRollup;
  if (Array.isArray(rollup) && rollup.length > 0) {
    let failing = false;
    let pending = false;
    for (const c of rollup) {
      const conclusion = (c.conclusion ?? c.state ?? '').toUpperCase();
      const status = (c.status ?? '').toUpperCase();
      if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED' || conclusion === 'ERROR') {
        failing = true;
      } else if (conclusion === 'PENDING' || (status && status !== 'COMPLETED')) {
        pending = true;
      }
    }
    checks = failing ? 'failing' : pending ? 'pending' : 'passing';
  }
  return { number: json.number, state, checks, url: json.url };
}

export class PrStatusCache {
  private cache = new Map<string, CacheEntry>();
  /** Tri-state gh availability: unknown until first probe. */
  private ghAvailable: boolean | null = null;

  constructor(
    private now: () => number = Date.now,
    private exec: (
      cmd: string,
      args: string[],
      opts: { cwd?: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
    ) => Promise<{ stdout: string }> = execFileAsync,
  ) {}

  /**
   * PR status for the branch checked out at `cwd`. Resolves null on every
   * failure path (gh missing, not a repo, no PR, auth error) — quiet
   * absence is the contract. `branch` is only a cache-key component; gh
   * itself resolves the PR from the checkout.
   */
  async get(input: PaneCommandTarget | string, branch: string): Promise<PrStatus | null> {
    const target = typeof input === 'string' ? hostCommandTarget(input) : input;
    if (this.ghAvailable === false) return null;
    if (!preparePaneCommand(target, process.platform === 'win32' ? 'gh.exe' : 'gh', ['pr', 'view']).ok) {
      return null;
    }
    const key = cacheKey(target, branch);
    const entry = this.cache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending;
      if (now - entry.fetchedAt < TTL_MS) return entry.value;
    }

    const pending = this.fetch(target)
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

  /** Drop a single cache entry (used when the branch changes so the next poll refetches). */
  invalidate(input: PaneCommandTarget | string, branch: string): void {
    const target = typeof input === 'string' ? hostCommandTarget(input) : input;
    this.cache.delete(cacheKey(target, branch));
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

  private async fetch(target: PaneCommandTarget): Promise<PrStatus | null> {
    try {
      const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
      const command = preparePaneCommand(
        target,
        executable,
        ['pr', 'view', '--json', 'number,state,isDraft,url,statusCheckRollup'],
      );
      if (!command.ok) return null;
      const { stdout } = await this.exec(
        command.file,
        command.args,
        {
          ...(command.cwd ? { cwd: command.cwd } : {}),
          timeout: GH_TIMEOUT_MS,
          // Force non-interactive: gh must never block the metadata poll on
          // a login prompt or pager.
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' },
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      this.ghAvailable = true;
      return mapGhPrView(JSON.parse(stdout) as GhPrViewJson);
    } catch (err) {
      // ENOENT = gh not installed → permanently silent for this process.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.ghAvailable = false;
      }
      // "no pull requests found" exits 1 — also lands here. Quiet absence.
      return null;
    }
  }
}

/** Process-wide singleton — one TTL window shared by every caller. */
export const prStatusCache = new PrStatusCache();
