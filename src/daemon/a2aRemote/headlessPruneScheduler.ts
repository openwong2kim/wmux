import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Git } from '../../main/a2aRemote/spawnWorktree';
import { getExecEnv } from '../../shared/execEnv';
import { resolveExecutable } from '../../shared/exeSearch';
import type { MergedChecks, PruneEntry, PruneKeptKind, PruneResult } from '../../cli/commands/headlessPrune';

/**
 * The box daemon prunes the worktrees of ended headless starts by itself:
 * every AUTO_PRUNE_INTERVAL_MS, and AUTO_PRUNE_AFTER_END_MS after a start
 * ends. It runs `wmux daemon headless prune`'s pass with the 'merged' policy
 * (headlessPrune.ts): only a clean worktree whose work is in origin's default
 * branch, or is the head of a merged pull request, goes. Work that is
 * unpushed, pushed but not merged, or not committed stays, and one line says
 * how much stays and how large it is, so the box's operator can decide
 * (`wmux daemon headless prune --dry-run` lists it).
 *
 * One pass at a time; a pass that is asked for while one runs is not queued
 * (the next timer or end asks again). Only while the daemon is headless.
 */

export const AUTO_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** After a start ends: its end (session destroyed, record updated) is done by then. */
export const AUTO_PRUNE_AFTER_END_MS = 2 * 60 * 1000;
/** The size walk of the kept worktrees stops after this long, or this many entries, and says "at least". */
const SIZE_WALK_MS = 10_000;
const SIZE_WALK_ENTRIES = 200_000;

export interface PruneSchedulerDeps {
  /** The daemon runs headless (a box): pruning happens only then. */
  active: () => boolean;
  /** One pass of the 'merged' policy (pruneHeadless). */
  prune: () => Promise<PruneResult>;
  log: (level: 'info' | 'warn', message: string) => void;
  /** The bytes under a folder, and whether that is all of them; defaults to an async walk. */
  sizeOf?: (dir: string) => Promise<{ bytes: number; complete: boolean }>;
}

export class HeadlessPruneScheduler {
  private interval: NodeJS.Timeout | null = null;
  private afterEnd: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: PruneSchedulerDeps) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => { void this.runOnce(); }, AUTO_PRUNE_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.afterEnd) clearTimeout(this.afterEnd);
    this.interval = null;
    this.afterEnd = null;
  }

  /** A headless start is ending: a pass follows once it has ended (several ends together share one). */
  noteStartEnded(): void {
    if (this.afterEnd) clearTimeout(this.afterEnd);
    this.afterEnd = setTimeout(() => {
      this.afterEnd = null;
      void this.runOnce();
    }, AUTO_PRUNE_AFTER_END_MS);
    this.afterEnd.unref?.();
  }

  /** One pass, unless one runs (its promise then). Never throws. */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    if (!this.deps.active()) return Promise.resolve();
    this.running = this.pass()
      .catch((err: unknown) => this.deps.log('warn', `[headless] auto-prune failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<void> {
    const res = await this.deps.prune();
    for (const e of res.removed) this.deps.log('info', `[headless] auto-prune: removed ${e.worktreePath} (${e.spawnId} from ${e.hostId}): ${e.reason}`);
    if (res.kept.length === 0) return;
    const sizeOf = this.deps.sizeOf ?? folderSize;
    let bytes = 0;
    let complete = true;
    for (const e of res.kept) {
      // eslint-disable-next-line no-await-in-loop -- one walk at a time, off the event loop's hot path
      const size = await sizeOf(e.worktreePath).catch(() => ({ bytes: 0, complete: false }));
      bytes += size.bytes;
      complete &&= size.complete;
    }
    this.deps.log('info', keptSummary(res.kept, bytes, complete));
  }
}

const KIND_WORDS: Record<PruneKeptKind, string> = {
  unmerged: 'with commits not merged into the default branch',
  dirty: 'with uncommitted changes',
  held: 'with processes of their agent still running',
  other: 'that could not be checked',
};

/** `kept 3 worktree(s), 1.2 GB: 2 with commits not merged …, 1 with uncommitted changes; …`. */
export function keptSummary(kept: readonly PruneEntry[], bytes: number, complete: boolean): string {
  const counts = new Map<PruneKeptKind, number>();
  for (const e of kept) counts.set(e.kind ?? 'other', (counts.get(e.kind ?? 'other') ?? 0) + 1);
  const parts = (Object.keys(KIND_WORDS) as PruneKeptKind[]).filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${KIND_WORDS[k]}`);
  return `[headless] auto-prune: kept ${kept.length} worktree(s), ${complete ? '' : 'at least '}${formatBytes(bytes)}: ${parts.join(', ')}; `
    + 'they stay until removed by hand (`wmux daemon headless prune --dry-run` lists them)';
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The bytes of the files under `dir` (links not followed), within SIZE_WALK_MS and SIZE_WALK_ENTRIES. */
export async function folderSize(dir: string, limits: { ms?: number; entries?: number } = {}): Promise<{ bytes: number; complete: boolean }> {
  const deadline = Date.now() + (limits.ms ?? SIZE_WALK_MS);
  let budget = limits.entries ?? SIZE_WALK_ENTRIES;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    if (Date.now() > deadline || budget <= 0) return { bytes, complete: false };
    const at = stack.pop() as string;
    let entries: fs.Dirent[];
    // eslint-disable-next-line no-await-in-loop -- a walk, one folder at a time
    try { entries = await fs.promises.readdir(at, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (Date.now() > deadline || budget <= 0) return { bytes, complete: false };
      budget--;
      const p = path.join(at, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) {
        // eslint-disable-next-line no-await-in-loop -- see above
        try { bytes += (await fs.promises.lstat(p)).size; } catch { /* gone meanwhile */ }
      }
    }
  }
  return { bytes, complete: true };
}

/** gh, run for a check: its JSON stdout, or null on any failure (none installed, not signed in, a timeout). */
export type GhRunner = (args: string[], cwd: string) => Promise<string | null>;

/** gh found the way git is (the login shell's PATH, not a service's thin one). */
export const ghRunner: GhRunner = (args, cwd) => new Promise((resolve) => {
  const env = { ...getExecEnv(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  execFile(resolveExecutable('gh', { env }), args, { cwd, env, timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    (err, stdout) => resolve(err ? null : stdout));
});

const SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * The 'merged' policy's checks on this box. The default branch is origin's
 * HEAD as this clone knows it (else `main`, else `master`), fetched once per
 * repository per pass so a merge since the start shows up; a failed fetch
 * judges by what the clone already knows. A pull request counts only when
 * gh lists a merged one for the branch whose head is the commit, or contains
 * it; no gh, no sign-in or no answer is null (not known), and keeps the worktree.
 */
export function mergedChecks(deps: { git: (at: string) => Git; gh?: GhRunner }): MergedChecks {
  const fetched = new Map<string, Promise<string | null>>();
  const gh = deps.gh ?? ghRunner;
  const resolveDefault = async (repoPath: string): Promise<string | null> => {
    const git = deps.git(repoPath);
    const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    let ref = head.code === 0 && /^origin\/[^\s]+$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
    for (const fallback of ['origin/main', 'origin/master']) {
      if (ref) break;
      // eslint-disable-next-line no-await-in-loop -- two refs at most
      if ((await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${fallback}`])).code === 0) ref = fallback;
    }
    if (!ref) return null;
    const branch = ref.slice('origin/'.length);
    await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/${ref}`]);
    return ref;
  };
  return {
    defaultRef: (repoPath) => {
      let ref = fetched.get(repoPath);
      if (!ref) fetched.set(repoPath, (ref = resolveDefault(repoPath).catch(() => null)));
      return ref;
    },
    pullRequestMerged: async (worktreePath, branch, sha) => {
      const out = await gh(['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '--limit', '20'], worktreePath);
      if (out === null) return null;
      let heads: string[];
      try {
        const parsed = JSON.parse(out) as unknown;
        if (!Array.isArray(parsed)) return null;
        heads = parsed.map((p) => (p as { headRefOid?: unknown }).headRefOid).filter((h): h is string => typeof h === 'string' && SHA_RE.test(h));
      } catch {
        return null;
      }
      if (heads.includes(sha)) return true;
      const git = deps.git(worktreePath);
      for (const head of heads) {
        // eslint-disable-next-line no-await-in-loop -- a few pull requests at most
        if ((await git(['merge-base', '--is-ancestor', sha, head])).code === 0) return true;
      }
      return false;
    },
  };
}
