// Sibling worktree collision watch: warn while two worktrees of one repo are
// still being worked on that they edit the same file, instead of only when a
// merge session starts (mergeSession.runMergeNoCommit).
//
// Read-only by construction:
//  - Every git call carries `--no-optional-locks`, so `status` / `diff` never
//    refresh or lock a worktree's index under the agent working in it.
//  - The dry-run merge is `git merge-tree --write-tree` on captured HEAD OIDs
//    (git >= 2.38). It writes the merged tree's objects, so it runs with a
//    throwaway object directory (GIT_OBJECT_DIRECTORY) that reads the repo's
//    real objects as an alternate; nothing lands in the repo, no ref, index or
//    checkout is touched. The scratch directory is removed after each round.
//  - Older git: no merge-tree; the changed-file sets since the merge base are
//    compared and reported as "same file changed", never as a conflict.
//
// Uncommitted work counts too: `git status --porcelain -z` (tracked changes
// and untracked files) is read in each worktree, and a file one side has
// uncommitted that the other side also changed is reported as an overlap.
//
// Bounds: one git process at a time per repository, a 10 s timeout per call,
// a doubling back-off after a failed round, and no timer at all while fewer
// than two siblings of any repo are open.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { getExecEnv } from '../../shared/execEnv';
import { resolveExecutable } from '../../shared/exeSearch';
import { isIntegrationPath, parseNulList } from './mergeSession';
import {
  EMPTY_SIBLING_COLLISIONS,
  clampSiblingCollisionInterval,
  type SiblingCollisionEntry,
  type SiblingCollisionSnapshot,
  type SiblingCollisionWatchRequest,
} from '../../shared/siblingCollision';

export const GIT_CALL_TIMEOUT_MS = 10_000;
/** A pane going idle asks for a check this soon (debounced). */
export const POKE_DELAY_MS = 3_000;
/** Back-off cap after repeated failed rounds. */
export const MAX_BACKOFF_MS = 30 * 60_000;

export interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Killed by the timeout or failed to start — never a git answer. */
  readonly failed: boolean;
}

export type GitRunner = (args: string[], cwd: string, env?: Record<string, string>) => Promise<GitRun>;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** `git version 2.50.1 (Apple Git-155)` → whether `merge-tree --write-tree` exists (>= 2.38). */
export function supportsMergeTreeWriteTree(versionOutput: string): boolean {
  const m = versionOutput.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 38);
}

export type MergeTreeParse = { ok: true; tree: string; conflicts: string[] } | { ok: false };

/**
 * Parse `git merge-tree --write-tree --name-only --no-messages -z` stdout:
 * `<tree-oid>\0<path>\0<path>\0…` — the paths are the conflicted files (none
 * on a clean merge). With messages left on, an empty field ends the path list,
 * so parsing stops there too. Anything not starting with an object id is a
 * failure (bad revision, old git), never "no conflict".
 */
export function parseMergeTreeOutput(stdout: string): MergeTreeParse {
  const fields = stdout.split('\0');
  const tree = (fields[0] ?? '').trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) return { ok: false };
  const conflicts: string[] = [];
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    if (f === '') break;
    if (!conflicts.includes(f)) conflicts.push(f);
  }
  return { ok: true, tree, conflicts };
}

/** Paths in `git status --porcelain=v1 -z` output (both sides of a rename or copy). */
export function parsePorcelainPaths(stdout: string): string[] {
  const entries = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    out.push(e.slice(3));
    // A rename/copy entry is followed by its original path as its own field.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = entries[i + 1];
      if (orig) out.push(orig);
      i++;
    }
  }
  return [...new Set(out)];
}

export interface ResolvedWorktree {
  readonly cwd: string;
  readonly worktreePath: string;
  /** The repository's common git dir (shared by its worktrees) — the group key. */
  readonly commonDir: string;
}

/**
 * Group resolved folders into sibling sets: distinct worktrees of one repo,
 * merge-session integration worktrees left out. Only repos with two or more
 * siblings are returned; worktree paths in each group are sorted.
 */
export function siblingGroups(resolved: readonly ResolvedWorktree[]): Map<string, string[]> {
  const byRepo = new Map<string, Set<string>>();
  for (const r of resolved) {
    if (isIntegrationPath(r.worktreePath)) continue;
    let set = byRepo.get(r.commonDir);
    if (!set) byRepo.set(r.commonDir, (set = new Set()));
    set.add(r.worktreePath);
  }
  const out = new Map<string, string[]>();
  for (const [repo, set] of byRepo) if (set.size >= 2) out.set(repo, [...set].sort());
  return out;
}

/** Every unordered pair of a sorted list, in order. */
export function pairsOf<T>(items: readonly T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
  return out;
}

export interface PairResult {
  readonly a: string;
  readonly b: string;
  readonly conflicts: string[];
  readonly overlaps: string[];
}

/** The snapshot the renderer gets: per sent cwd, its worktree's colliding peers. */
export function buildSnapshot(resolved: readonly ResolvedWorktree[], pairs: readonly PairResult[]): SiblingCollisionSnapshot {
  const peersOf = new Map<string, SiblingCollisionEntry['peers']>();
  const add = (self: string, other: string, p: PairResult) => {
    let list = peersOf.get(self);
    if (!list) peersOf.set(self, (list = []));
    list.push({ worktreePath: other, conflicts: p.conflicts, overlaps: p.overlaps });
  };
  for (const p of pairs) {
    if (p.conflicts.length === 0 && p.overlaps.length === 0) continue;
    add(p.a, p.b, p);
    add(p.b, p.a, p);
  }
  const byCwd: SiblingCollisionSnapshot['byCwd'] = {};
  const cwdsByWorktree: SiblingCollisionSnapshot['cwdsByWorktree'] = {};
  for (const r of resolved) {
    (cwdsByWorktree[r.worktreePath] ??= []).push(r.cwd);
    const peers = peersOf.get(r.worktreePath);
    if (peers) byCwd[r.cwd] = { worktreePath: r.worktreePath, peers };
  }
  return { byCwd, cwdsByWorktree };
}

/** Files both change sets hold; with `onlyIf`, just those also in it. Sorted. */
export function sharedFiles(a: ReadonlySet<string>, b: ReadonlySet<string>, onlyIf?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of a) if (b.has(f) && (!onlyIf || onlyIf.has(f))) out.push(f);
  return out.sort();
}

// ── git runner ────────────────────────────────────────────────────────────────

/** The real runner: absolute git, fsmonitor off, no optional locks, 10 s timeout. */
export const runGit: GitRunner = (args, cwd, extraEnv) =>
  new Promise((done) => {
    const env = { ...getExecEnv(), ...(extraEnv ?? {}) };
    let exe: string;
    try {
      exe = resolveExecutable('git', { env });
    } catch {
      done({ code: 1, stdout: '', stderr: 'git not found', failed: true });
      return;
    }
    execFile(
      exe,
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
      { cwd, timeout: GIT_CALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr, failed: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        const exitCode = typeof e.code === 'number' ? e.code : null;
        done({ code: exitCode ?? 1, stdout: stdout ?? '', stderr: stderr ?? String(err), failed: exitCode === null || e.killed === true });
      },
    );
  });

// ── The watcher ───────────────────────────────────────────────────────────────

interface WorktreeState {
  readonly head: string;
  readonly dirty: ReadonlySet<string>;
  readonly key: string;
}

export interface WatcherDeps {
  run?: GitRunner;
  emit: (snapshot: SiblingCollisionSnapshot) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Makes and removes the throwaway object directory (tests stub it). */
  makeScratch?: () => Promise<string>;
  dropScratch?: (dir: string) => Promise<void>;
}

class RoundError extends Error {}

/**
 * Runs rounds: resolve every sent folder, then per repo (serially, one git
 * process at a time) read each sibling's HEAD and uncommitted files and
 * dry-run each pair whose inputs changed since the last round.
 */
export class SiblingCollisionWatcher {
  private readonly run: GitRunner;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly makeScratch: () => Promise<string>;
  private readonly dropScratch: (dir: string) => Promise<void>;
  private enabled = false;
  private intervalMs = clampSiblingCollisionInterval(undefined);
  private cwds: string[] = [];
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private failures = 0;
  private disposed = false;
  private mergeTree: boolean | null = null;
  private lastEmitted = JSON.stringify(EMPTY_SIBLING_COLLISIONS);
  /** Pair key (both sides' head + dirty set) → result, so an unchanged pair costs no git. */
  private pairCache = new Map<string, PairResult>();

  constructor(private readonly deps: WatcherDeps) {
    this.run = deps.run ?? runGit;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.makeScratch = deps.makeScratch ?? (() => mkdtemp(join(tmpdir(), 'wmux-merge-tree-')));
    this.dropScratch = deps.dropScratch ?? ((dir) => rm(dir, { recursive: true, force: true }));
  }

  configure(req: SiblingCollisionWatchRequest): void {
    if (this.disposed) return;
    const cwds = [...new Set((Array.isArray(req.cwds) ? req.cwds : []).filter((c) => typeof c === 'string' && isAbsolute(c)))].sort();
    const enabled = req.enabled === true;
    const intervalMs = clampSiblingCollisionInterval(req.intervalMs);
    const changed = enabled !== this.enabled || intervalMs !== this.intervalMs || cwds.join('\0') !== this.cwds.join('\0');
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.cwds = cwds;
    if (!changed) return;
    if (!enabled || cwds.length < 2) {
      this.cancelTimer();
      this.pairCache.clear();
      this.publish(EMPTY_SIBLING_COLLISIONS);
      return;
    }
    this.schedule(0);
  }

  /** A pane went idle: check soon (debounced), if anything is being watched. */
  poke(): void {
    if (this.disposed || !this.enabled || this.cwds.length < 2) return;
    this.schedule(POKE_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  /** Test hook: the in-flight round, if any. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.startRound();
    }, ms);
  }

  private startRound(): void {
    if (this.disposed || this.running) return;
    this.running = this.round()
      .then((siblingsOpen) => {
        this.failures = 0;
        return siblingsOpen;
      })
      .catch(() => {
        this.failures++;
        return true;
      })
      .then((siblingsOpen) => {
        this.running = null;
        if (this.disposed || !this.enabled || this.cwds.length < 2) return;
        if (this.rerun) {
          this.rerun = false;
          this.schedule(0);
          return;
        }
        // No timer while fewer than two siblings are open: a new pane, a cwd
        // change (configure) or an idle poke starts the next round.
        if (!siblingsOpen) return;
        const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failures);
        this.schedule(backoff);
      });
  }

  /** One round. Resolves whether any repo has two or more siblings open. Throws on a failed git call. */
  private async round(): Promise<boolean> {
    const resolved: ResolvedWorktree[] = [];
    for (const cwd of this.cwds) {
      const r = await this.run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], cwd);
      if (r.failed) throw new RoundError('rev-parse timed out');
      if (r.code !== 0) continue; // not a git folder (or gone) — not a sibling
      const [top, common] = r.stdout.split('\n').map((l) => l.trim());
      if (top && common) resolved.push({ cwd, worktreePath: resolve(top), commonDir: resolve(common) });
    }
    const groups = siblingGroups(resolved);
    if (groups.size === 0) {
      this.pairCache.clear();
      this.publish(buildSnapshot(resolved, []));
      return false;
    }
    if (this.mergeTree === null) {
      const v = await this.run(['version'], this.cwds[0]);
      if (v.failed) throw new RoundError('git version timed out');
      this.mergeTree = supportsMergeTreeWriteTree(v.stdout);
    }
    // Repos in parallel, each strictly serial inside.
    const perRepo = await Promise.allSettled([...groups].map(([commonDir, paths]) => this.checkRepo(commonDir, paths)));
    const results: PairResult[] = [];
    let failed = false;
    for (const r of perRepo) {
      if (r.status === 'fulfilled') results.push(...r.value);
      else failed = true;
    }
    const keep = new Set(results.map((p) => p.a + '\0' + p.b));
    // A repo that failed this round keeps showing what it showed last.
    if (failed) {
      for (const p of this.pairCache.values()) if (!keep.has(p.a + '\0' + p.b)) results.push(p);
    }
    this.publish(buildSnapshot(resolved, dedupePairs(results)));
    if (failed) throw new RoundError('a repo check failed');
    return true;
  }

  private async checkRepo(commonDir: string, paths: string[]): Promise<PairResult[]> {
    const states = new Map<string, WorktreeState>();
    for (const p of paths) {
      const head = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], p);
      if (head.failed) throw new RoundError('HEAD read timed out');
      if (head.code !== 0) continue; // unborn branch: nothing committed to compare yet
      const st = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], p);
      if (st.failed || st.code !== 0) throw new RoundError('status failed');
      const dirty = new Set(parsePorcelainPaths(st.stdout));
      const oid = head.stdout.trim();
      states.set(p, { head: oid, dirty, key: `${oid}:${[...dirty].sort().join('\0')}` });
    }
    const out: PairResult[] = [];
    let scratch: string | null = null;
    try {
      for (const [[a, sa], [b, sb]] of pairsOf([...states])) {
        const cacheKey = `${a}\0${b}\0${sa.key}\0${sb.key}`;
        const cached = this.pairCache.get(cacheKey);
        if (cached) {
          out.push(cached);
          continue;
        }
        if (this.mergeTree && scratch === null) scratch = await this.makeScratch();
        const result = await this.checkPair(commonDir, scratch, a, sa, b, sb);
        // Drop the pair's older entries so the cache holds one per pair.
        for (const k of this.pairCache.keys()) if (k.startsWith(`${a}\0${b}\0`)) this.pairCache.delete(k);
        this.pairCache.set(cacheKey, result);
        out.push(result);
      }
    } finally {
      if (scratch !== null) await this.dropScratch(scratch).catch(() => undefined);
    }
    return out;
  }

  private async checkPair(
    commonDir: string,
    scratch: string | null,
    a: string,
    sa: WorktreeState,
    b: string,
    sb: WorktreeState,
  ): Promise<PairResult> {
    let conflicts: string[] = [];
    if (this.mergeTree && scratch !== null) {
      const env = { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, 'objects') };
      const mt = await this.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', sa.head, sb.head], a, env);
      if (mt.failed) throw new RoundError('merge-tree timed out');
      const parsed = parseMergeTreeOutput(mt.stdout);
      // exit 0 = clean, 1 = conflicts; anything that does not parse is a failure.
      if (!parsed.ok || (mt.code !== 0 && mt.code !== 1)) throw new RoundError('merge-tree failed');
      conflicts = parsed.conflicts.sort();
    }
    const anyDirty = sa.dirty.size > 0 || sb.dirty.size > 0;
    let overlaps: string[] = [];
    if (!this.mergeTree || anyDirty) {
      const changedA = new Set(sa.dirty);
      const changedB = new Set(sb.dirty);
      if (sa.head !== sb.head) {
        const mb = await this.run(['merge-base', sa.head, sb.head], a);
        if (mb.failed) throw new RoundError('merge-base timed out');
        const base = mb.code === 0 ? mb.stdout.trim() : '';
        if (base) {
          for (const [head, set] of [[sa.head, changedA], [sb.head, changedB]] as const) {
            if (head === base) continue;
            const d = await this.run(['diff', '--name-only', '-z', '--no-renames', base, head], a);
            if (d.failed || d.code !== 0) throw new RoundError('diff failed');
            for (const f of parseNulList(d.stdout)) set.add(f);
          }
        }
      }
      // With merge-tree, committed-vs-committed is already answered exactly;
      // an overlap is only reported where uncommitted work is involved.
      const uncommitted = this.mergeTree ? new Set([...sa.dirty, ...sb.dirty]) : undefined;
      const known = new Set(conflicts);
      overlaps = sharedFiles(changedA, changedB, uncommitted).filter((f) => !known.has(f));
    }
    return { a, b, conflicts, overlaps };
  }

  private publish(snapshot: SiblingCollisionSnapshot): void {
    const json = JSON.stringify(snapshot);
    if (json === this.lastEmitted) return;
    this.lastEmitted = json;
    this.deps.emit(snapshot);
  }
}

function dedupePairs(pairs: PairResult[]): PairResult[] {
  const seen = new Map<string, PairResult>();
  for (const p of pairs) seen.set(p.a + '\0' + p.b, p);
  return [...seen.values()];
}
