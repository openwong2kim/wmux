import { execFile } from 'node:child_process';
import { access as fsAccess } from 'node:fs/promises';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/** How long a resolved branch is reused before `git` is asked again. */
export const GIT_BRANCH_HIT_TTL_MS = 15_000;
/**
 * How long "not a repo" is remembered. This cache is the second layer: the
 * root fix is that a pane the GitContextWatcher knows is outside a repo never
 * reaches this fallback (metadata.handler's known-absent state). What is left
 * are panes the watcher has no answer for (no event yet, a failed HEAD read,
 * no live watch); without this, each of those outside a repo spawned git on
 * every 5 s tick. A directory that becomes a repo (`git init`, `git clone .`)
 * is picked up at the next expiry; the watcher path still reports a branch
 * the moment the shell integration or GitContextWatcher sees one.
 */
export const GIT_BRANCH_MISS_TTL_MS = 60_000;
/**
 * How long a FAILED lookup is held: the 3 s exec timeout, a lock held by
 * antivirus, git missing from PATH. Not a verdict on the directory, so it
 * must not hide a branch for a minute; held just long enough to not retry
 * on the very next 5 s tick.
 */
export const GIT_BRANCH_ERROR_TTL_MS = 5_000;
/** Bound on remembered directories. */
export const GIT_BRANCH_CACHE_MAX = 256;

/**
 * A cwd inside a WSL distro, as the shell hook reports it (`wslpath -w`,
 * either slash). Host git cannot answer for it: Git for Windows refuses every
 * repository there as "dubious ownership" (src/main/git/dubiousOwnership.ts),
 * and each lookup is a round trip into the distro. The watcher, which reads
 * `.git/HEAD` over the same path without git, is the only source there.
 */
const WSL_UNC_CWD = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]/i;

/** `exec` result: a branch, `undefined` for "not a repo", `null` for a failed lookup. */
export type GitBranchLookup = string | undefined | null;

interface BranchEntry {
  branch: string | undefined;
  expiresAt: number;
  inflight?: Promise<string | undefined>;
}

// X1: the old machine-global getListeningPorts()/collect() pair is gone —
// ports are now PID-tree-scoped via PortWatcher (src/main/pty/portWatch.ts)
// and the metadata poll assembles payloads from watcher-fed caches
// (metadata.handler.buildMetadataPayload). Only the git-branch exec
// fallback remains, for sessions the fs.watch GitContextWatcher missed.
export class MetadataCollector {
  private readonly branches = new Map<string, BranchEntry>();
  private readonly now: () => number;
  private readonly exec: (cwd: string) => Promise<GitBranchLookup>;

  constructor(deps: {
    now?: () => number;
    /** Injected for tests; the default spawns `git symbolic-ref --short -q HEAD`. */
    exec?: (cwd: string) => Promise<GitBranchLookup>;
  } = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.exec = deps.exec ?? MetadataCollector.execGitBranch;
  }

  /**
   * The branch at `cwd` (`HEAD` when detached), or undefined when it is not
   * inside a repo. A per-directory TTL cache, the second layer behind the
   * watcher's answer: a hit for GIT_BRANCH_HIT_TTL_MS, "not a repo" for
   * GIT_BRANCH_MISS_TTL_MS, a failed lookup for GIT_BRANCH_ERROR_TTL_MS.
   * Concurrent callers for one directory share a single spawn. A lookup
   * never rejects: a rejecting `exec` counts as a failed lookup. A WSL path
   * never spawns host git (see WSL_UNC_CWD).
   */
  async getGitBranch(cwd: string): Promise<string | undefined> {
    if (WSL_UNC_CWD.test(cwd)) return undefined;
    const now = this.now();
    const cached = this.branches.get(cwd);
    if (cached) {
      if (cached.inflight) return cached.inflight;
      if (cached.expiresAt > now) return cached.branch;
    }
    const inflight: Promise<string | undefined> = Promise.resolve()
      .then(() => this.exec(cwd))
      .then((found) => found, () => null)
      .then((found) => {
        // Only the lookup that still owns the entry may write it, so an
        // older spawn finishing last cannot overwrite a newer answer.
        if (this.branches.get(cwd)?.inflight !== inflight) return found ?? undefined;
        const settledAt = this.now();
        const branch = found ?? undefined;
        const ttl = found === null ? GIT_BRANCH_ERROR_TTL_MS : found ? GIT_BRANCH_HIT_TTL_MS : GIT_BRANCH_MISS_TTL_MS;
        this.remember(cwd, { branch, expiresAt: settledAt + ttl });
        return branch;
      });
    this.remember(cwd, { branch: cached?.branch, expiresAt: 0, inflight });
    return inflight;
  }

  private remember(cwd: string, entry: BranchEntry): void {
    // Re-insert so the map's iteration order is recency; evict the oldest.
    this.branches.delete(cwd);
    this.branches.set(cwd, entry);
    while (this.branches.size > GIT_BRANCH_CACHE_MAX) {
      const oldest = this.branches.keys().next().value;
      if (oldest === undefined) break;
      this.branches.delete(oldest);
    }
  }

  /**
   * The failures that are an ANSWER about the directory (held for the miss
   * TTL), told apart from a lookup that merely failed (held briefly):
   *   - "not a git repository" — outside a repo;
   *   - "dubious ownership" — git refuses the repo (common on Windows
   *     external drives and WSL paths), and will keep refusing;
   *   - ENOENT on the cwd itself — the directory is gone.
   * `git symbolic-ref` rather than `rev-parse --abbrev-ref`: a repo on an
   * unborn branch (fresh `git init`) answers with its branch name, the same
   * label the watcher reads from `.git/HEAD`, where `rev-parse` failed with
   * `ambiguous argument 'HEAD'` and the header showed nothing.
   * `LC_ALL=C` because git translates these messages (ko: "깃 저장소가
   * 아닙니다", and de/zh_CN among others); matched in another locale, every
   * non-repo pane would read as a failed lookup and be polled again in 5 s —
   * the very spawn this cache removes.
   */
  private static async execGitBranch(cwd: string): Promise<GitBranchLookup> {
    try {
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
        cwd,
        timeout: 3000,
        env: { ...getExecEnv(), LC_ALL: 'C' },
      });
      const branch = stdout.trim();
      return branch || undefined;
    } catch (err) {
      const e = err as { stderr?: unknown; code?: unknown };
      // `-q` on a detached HEAD: exit 1, no message (every other failure is
      // 128). Show `HEAD`, which is what `rev-parse --abbrev-ref HEAD` printed.
      if (e.code === 1) return 'HEAD';
      if (e.code === 'ENOENT' && !(typeof e.stderr === 'string' && e.stderr.length > 0)) {
        // Node reports ENOENT both for a missing cwd and a missing git binary;
        // only the former is an answer about the directory.
        try { await fsAccess(cwd); } catch { return undefined; }
        return null;
      }
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      return /not a git repository|dubious ownership/i.test(stderr) ? undefined : null;
    }
  }
}
