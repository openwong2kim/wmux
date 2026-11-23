import { existsSync } from 'fs';
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
 */

export interface PruneEntry {
  spawnId: string;
  hostId: string;
  worktreePath: string;
  reason: string;
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

/** Whether this start's worktree may go, and why (or why not). */
async function judge(rec: HeadlessStartRecordV1, git: Git): Promise<{ ok: boolean; reason: string; tip?: string | null }> {
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  if (status.code !== 0) return { ok: false, reason: 'git status failed' };
  if (status.stdout.trim() !== '') return { ok: false, reason: 'it has uncommitted or untracked changes' };
  const head = await revOf(git, 'HEAD');
  if (!head) return { ok: false, reason: 'its HEAD could not be read' };
  const tip = rec.branch ? await revOf(git, `refs/heads/${rec.branch}`) : null;
  const shas = [...new Set([head, ...(tip ? [tip] : [])])];
  const ways: string[] = [];
  for (const sha of shas) {
    // eslint-disable-next-line no-await-in-loop -- two commits at most
    const way = await elsewhere(git, sha, rec.fetchedHead);
    if (!way) return { ok: false, reason: `commit ${sha.slice(0, 12)} is not pushed and was not fetched back` };
    ways.push(way);
  }
  return { ok: true, reason: `clean, ${[...new Set(ways)].join(' and ')}`, tip };
}

export async function pruneHeadless(
  wmuxDir: string,
  opts: { dryRun: boolean; daemonRunning: boolean },
  deps: PruneDeps = {},
): Promise<PruneResult> {
  const gitAt = deps.git ?? ((at: string): Git => gitRunner(at, {}));
  const exists = deps.exists ?? existsSync;
  const store = new HeadlessStartStore({ dir: join(wmuxDir, 'a2a') });
  const removed: PruneEntry[] = [];
  const kept: PruneEntry[] = [];
  const gone: HeadlessStartRecordV1[] = [];
  for (const rec of store.list()) {
    if (rec.phase !== 'ended' || !rec.worktreePath) continue;
    const entry = { spawnId: rec.spawnId, hostId: rec.hostId, worktreePath: rec.worktreePath };
    if (!exists(rec.worktreePath)) {
      gone.push(rec);
      continue;
    }
    if (rec.survivors?.length) {
      kept.push({ ...entry, reason: 'processes of its agent may still run (see `wmux daemon headless status`)' });
      continue;
    }
    const git = gitAt(rec.worktreePath);
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const verdict = await judge(rec, git);
    if (!verdict.ok) {
      kept.push({ ...entry, reason: verdict.reason });
      continue;
    }
    if (opts.dryRun) {
      removed.push({ ...entry, reason: verdict.reason });
      continue;
    }
    // The tip as judged: the branch goes only while it is still there.
    const tip = verdict.tip ?? null;
    // eslint-disable-next-line no-await-in-loop -- one worktree at a time
    const out = await gitAt(rec.repoPath)(['worktree', 'remove', rec.worktreePath]);
    if (out.code !== 0) {
      kept.push({ ...entry, reason: `git worktree remove refused: ${(out.stderr || out.stdout).trim().split('\n')[0] ?? 'unknown'}` });
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
  // A running daemon owns the file: it drops a record whose worktree is gone at its next reconcile.
  if (!opts.dryRun && !opts.daemonRunning) {
    for (const rec of gone) {
      store.remove(rec.hostId, rec.spawnId);
      recordsDropped += 1;
    }
  }
  return { dryRun: opts.dryRun, removed, kept, recordsDropped };
}
