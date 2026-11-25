import { closeSync, existsSync, openSync, unlinkSync } from 'fs';
import { join } from 'path';
import { gitRunner, type Git } from '../../main/a2aRemote/spawnWorktree';
import { HeadlessStartStore, type HeadlessStartRecordV1 } from '../../daemon/a2aRemote/headlessStartStore';

/**
 * `wmux daemon headless prune [--dry-run]`: the kept worktrees of ended
 * headless starts that hold nothing this box alone has go, with their branch.
 * A worktree goes only when all of these hold:
 *   - its start ended and no process of its agent is still held for;
 *   - `git status` shows nothing modified or untracked (ignored files go with
 *     it, as `git worktree remove` takes them);
 *   - HEAD and its branch's tip are both on a remote-tracking ref (pushed), or
 *     inside the commit the asking PC last took back in a bundle (fetched).
 * It is removed with `git worktree remove` (never forced), then its branch with
 * `git update-ref -d` at the tip that was checked. Anything else is kept and
 * said why. No network fetch: "pushed" is what this clone's remote refs know.
 *
 * The box daemon's own pass (policy 'merged', headlessPruneScheduler.ts) is
 * stricter: work that is only pushed, or only fetched back, stays. HEAD and
 * the branch tip must each be inside origin's default branch, or be the head
 * of a pull request that was merged (squash merges leave no ancestor), and
 * whatever cannot be checked (no default branch, no answer about the pull
 * request) keeps the worktree.
 */

export interface PruneEntry {
  spawnId: string;
  hostId: string;
  worktreePath: string;
  reason: string;
  /** Why a worktree stays, by kind, for a summary: changes not committed, commits only this box has (or not merged), anything else. */
  kind?: PruneKeptKind;
}

export type PruneKeptKind = 'dirty' | 'unmerged' | 'held' | 'other';

/**
 * Which work may go: 'elsewhere' (the manual command) when it is pushed or
 * fetched back; 'merged' (the daemon's automatic pass) only when it is in
 * origin's default branch or its pull request was merged.
 */
export type PrunePolicy = 'elsewhere' | 'merged';

/** The checks the 'merged' policy makes beyond git's own refs. */
export interface MergedChecks {
  /** origin's default branch as a remote-tracking ref (`origin/main`), or null when it cannot be told. */
  defaultRef: (repoPath: string) => Promise<string | null>;
  /** Whether a merged pull request has `sha` as its head (or a head that contains it); null when that could not be asked. Never throws. */
  pullRequestMerged?: (worktreePath: string, branch: string, sha: string) => Promise<boolean | null>;
}

export interface PruneResult {
  dryRun: boolean;
  removed: PruneEntry[];
  kept: PruneEntry[];
  /** Records dropped now (no daemon answered); with a daemon running, it drops them at its next reconcile. */
  recordsDropped: number;
}

export interface PruneDeps {
  /** git in a folder (the worktree, or the repository it belongs to). */
  git?: (at: string) => Git;
  exists?: (p: string) => boolean;
  /** The store to read (the daemon passes its own); else one over `<wmuxDir>/a2a`. */
  store?: HeadlessStartStore;
  /** Required by the 'merged' policy. */
  merged?: MergedChecks;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

async function revOf(git: Git, ref: string): Promise<string | null> {
  const out = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = out.stdout.trim();
  return out.code === 0 && SHA_RE.test(sha) ? sha : null;
}

/** Why `sha` is safe elsewhere ('pushed' / 'fetched back'), or null when only this box has it. */
async function elsewhere(git: Git, sha: string, fetchedHead: string | undefined): Promise<string | null> {
  const local = await git(['rev-list', '--max-count=1', sha, '--not', '--remotes']);
  if (local.code === 0 && local.stdout.trim() === '') return 'pushed';
  if (fetchedHead && (sha === fetchedHead || (await git(['merge-base', '--is-ancestor', sha, fetchedHead])).code === 0)) return 'fetched back';
  return null;
}

/**
 * Why `sha` is in origin's default branch ('merged into origin/main' / 'its
 * pull request was merged'); 'unknown' when its pull request could not be
 * asked about; null when it is not merged.
 */
async function merged(git: Git, sha: string, defaultRef: string | null, rec: HeadlessStartRecordV1, checks: MergedChecks): Promise<string | 'unknown' | null> {
  if (defaultRef && (await git(['merge-base', '--is-ancestor', sha, `refs/remotes/${defaultRef}`])).code === 0) return `merged into ${defaultRef}`;
  if (!rec.branch || !rec.worktreePath || !checks.pullRequestMerged) return null;
  const pr = await checks.pullRequestMerged(rec.worktreePath, rec.branch, sha);
  return pr === null ? 'unknown' : pr ? 'its pull request was merged' : null;
}

type Verdict = { ok: true; reason: string; head: string; tip: string | null } | { ok: false; reason: string; kind: PruneKeptKind };

/** Whether this start's worktree may go, and why (or why not). */
async function judge(rec: HeadlessStartRecordV1, git: Git, policy: PrunePolicy, checks: MergedChecks | undefined): Promise<Verdict> {
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  if (status.code !== 0) return { ok: false, reason: 'git status failed', kind: 'other' };
  if (status.stdout.trim() !== '') return { ok: false, reason: 'it has uncommitted or untracked changes', kind: 'dirty' };
  const head = await revOf(git, 'HEAD');
  if (!head) return { ok: false, reason: 'its HEAD could not be read', kind: 'other' };
  const tip = rec.branch ? await revOf(git, `refs/heads/${rec.branch}`) : null;
  const shas = [...new Set([head, ...(tip ? [tip] : [])])];
  const ways: string[] = [];
  if (policy === 'merged') {
    if (!checks) return { ok: false, reason: 'merges cannot be checked', kind: 'other' };
    const defaultRef = await checks.defaultRef(rec.repoPath);
    for (const sha of shas) {
      // eslint-disable-next-line no-await-in-loop -- two commits at most
      const way = await merged(git, sha, defaultRef, rec, checks);
      const into = defaultRef ?? "origin's default branch";
      if (way === 'unknown') return { ok: false, reason: `commit ${sha.slice(0, 12)} is not in ${into}, and whether its pull request was merged could not be asked (gh)`, kind: 'other' };
      if (!way) return { ok: false, reason: `commit ${sha.slice(0, 12)} is not merged into ${into}`, kind: 'unmerged' };
      ways.push(way);
    }
    return { ok: true, reason: `clean, ${[...new Set(ways)].join(' and ')}`, head, tip };
  }
  for (const sha of shas) {
    // eslint-disable-next-line no-await-in-loop -- two commits at most
    const way = await elsewhere(git, sha, rec.fetchedHead);
    if (!way) return { ok: false, reason: `commit ${sha.slice(0, 12)} is not pushed and was not fetched back`, kind: 'unmerged' };
    ways.push(way);
  }
  return { ok: true, reason: `clean, ${[...new Set(ways)].join(' and ')}`, head, tip };
}

/**
 * Take the worktree's index lock, as `git commit` does, so no commit lands
 * between the last HEAD check and the removal (which deletes the lock with the
 * worktree's git folder). Null when it cannot be taken: another git process
 * holds it, or the folder could not be read. A writer that skips the index
 * (`git commit-tree` and `update-ref`) is not held off.
 */
async function lockIndex(git: Git): Promise<(() => void) | null> {
  const out = await git(['rev-parse', '--absolute-git-dir']);
  const dir = out.stdout.trim();
  if (out.code !== 0 || !dir) return null;
  const lock = join(dir, 'index.lock');
  try {
    closeSync(openSync(lock, 'wx'));
  } catch {
    return null;
  }
  return () => { try { unlinkSync(lock); } catch { /* gone with the worktree */ } };
}

/** Where `branch` is checked out (in the repository or a worktree of it), or null when nowhere or not known to be. */
async function checkedOutIn(git: Git, branch: string): Promise<string | null> {
  const out = await git(['worktree', 'list', '--porcelain']);
  if (out.code !== 0) return 'the worktrees of its repository could not be listed';
  let at = '';
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return `it is checked out in ${at}`;
  }
  return null;
}

export async function pruneHeadless(
  wmuxDir: string,
  /** `daemonRunning`: asked again right before records are dropped (a daemon started meanwhile owns the file). */
  opts: { dryRun: boolean; daemonRunning: () => Promise<boolean>; policy?: PrunePolicy },
  deps: PruneDeps = {},
): Promise<PruneResult> {
  const gitAt = deps.git ?? ((at: string): Git => gitRunner(at, {}));
  const exists = deps.exists ?? existsSync;
  const policy = opts.policy ?? 'elsewhere';
  const store = deps.store ?? new HeadlessStartStore({ dir: join(wmuxDir, 'a2a') });
  const removed: PruneEntry[] = [];
  const kept: PruneEntry[] = [];
  const gone: HeadlessStartRecordV1[] = [];
  for (const rec of store.list()) {
    if (rec.phase !== 'ended' || !rec.worktreePath) continue;
    const entry = { spawnId: rec.spawnId, hostId: rec.hostId, worktreePath: rec.worktreePath };
    // Held first: its record keeps the hold (and the port) even when its folder is gone.
    if (rec.survivors?.length) {
      kept.push({ ...entry, reason: 'processes of its agent may still run (see `wmux daemon headless status`)', kind: 'held' });
      continue;
    }
    if (!exists(rec.worktreePath)) {
      gone.push(rec);
      continue;
    }
    const git = gitAt(rec.worktreePath);
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const verdict = await judge(rec, git, policy, deps.merged);
    if (!verdict.ok) {
      kept.push({ ...entry, reason: verdict.reason, kind: verdict.kind });
      continue;
    }
    if (opts.dryRun) {
      removed.push({ ...entry, reason: verdict.reason });
      continue;
    }
    // The tip as judged: the branch goes only while it is still there.
    const tip = verdict.tip;
    // No commit from here to the removal; then HEAD again: a commit made since (a detached one has no branch to keep it) keeps it all.
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const unlock = await lockIndex(git);
    if (!unlock) {
      kept.push({ ...entry, reason: 'its index is locked (another git process may be at work in it)', kind: 'other' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    if (await revOf(git, 'HEAD') !== verdict.head) {
      unlock();
      kept.push({ ...entry, reason: 'its HEAD moved while it was checked', kind: 'other' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const out = await gitAt(rec.repoPath)(['worktree', 'remove', rec.worktreePath]);
    if (out.code !== 0) {
      unlock();
      kept.push({ ...entry, reason: `git worktree remove refused: ${(out.stderr || out.stdout).trim().split('\n')[0] ?? 'unknown'}`, kind: 'other' });
      continue;
    }
    // update-ref does not check worktrees: a branch checked out anywhere (the repository, another worktree) stays.
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const checkedOut = rec.branch ? await checkedOutIn(gitAt(rec.repoPath), rec.branch) : null;
    if (rec.branch && checkedOut !== null) {
      removed.push({ ...entry, reason: `${verdict.reason}; its branch ${rec.branch} was kept (${checkedOut})` });
      gone.push(rec);
      continue;
    }
    if (rec.branch && tip) {
      // eslint-disable-next-line no-await-in-loop -- one worktree at a time
      const del = await gitAt(rec.repoPath)(['update-ref', '-d', `refs/heads/${rec.branch}`, tip]);
      if (del.code !== 0) {
        removed.push({ ...entry, reason: `${verdict.reason}; its branch ${rec.branch} was kept (it moved, or could not be deleted)` });
        gone.push(rec);
        continue;
      }
    }
    removed.push({ ...entry, reason: verdict.reason });
    gone.push(rec);
  }
  let recordsDropped = 0;
  // A running daemon owns the file: it drops a record whose worktree is gone at its next reconcile. Otherwise the
  // file is read again now (not the copy read before the git work) and only records still ended and unheld go.
  if (!opts.dryRun && gone.length > 0 && !(await opts.daemonRunning())) {
    const fresh = new HeadlessStartStore({ dir: join(wmuxDir, 'a2a') });
    for (const rec of gone) {
      const now = fresh.get(rec.hostId, rec.spawnId);
      if (!now || now.phase !== 'ended' || now.survivors?.length || (now.worktreePath && exists(now.worktreePath))) continue;
      fresh.remove(rec.hostId, rec.spawnId);
      recordsDropped += 1;
    }
  }
  return { dryRun: opts.dryRun, removed, kept, recordsDropped };
}
