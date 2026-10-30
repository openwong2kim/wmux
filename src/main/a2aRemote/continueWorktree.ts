import fs from 'node:fs';
import path from 'node:path';
import { getWmuxHomeDir } from '../../shared/constants';
import { getExecEnv } from '../../shared/execEnv';
import { isContinueBranch, isContinueCommit, isContinueId, type A2aContinueStartFailure } from '../../shared/a2aContinue';
import { taskFetchConfigRefusal } from '../worktask/taskFetch';
import { originUrlFromConfigList, originUrlRepoKey, parseGitConfigList, workerGitConfigRefusal } from '../worktask/workerGit';
import { filterDriverNames, gitRunner, isBelow, isDirectory, ownConfig, realpathOrNull, samePath, type Git, type SpawnWorktreeOptions } from './spawnWorktree';

/**
 * The worktree a conversation another PC handed over resumes in (this PC is
 * B; see `shared/a2aContinue.ts`): `<worktrees root>/continue-<continueId>`,
 * on B's own copy of the request's branch, at A's commit.
 *
 * Only now, once the person approved, does B fetch: that one branch from
 * origin into its remote-tracking ref, nothing else (no tags, no submodules),
 * with no prompt. Then B's branch:
 *   - none yet: made at A's commit (create-only), and this start remembers it
 *     made it;
 *   - checked out in any worktree: `branch-busy`;
 *   - not an ancestor of A's commit: `diverged`;
 *   - else moved there, only from the tip it was read at.
 *
 * The git hardening is the remote spawn's (spawnWorktree.ts): no hooks, no
 * fsmonitor, no content filter, and a repository whose own config names a
 * program, another file or a URL rewrite is refused (workerGitConfigRefusal),
 * as is one whose origin is no longer the repository the request named. The
 * checkout reads the config again first, as the new worktree sees it.
 *
 * Undo (removeContinueWorktree) removes the worktree, deletes the branch only
 * if this start made it, and otherwise puts the old tip back; each ref write
 * names the value it expects, so a branch that moved since (a commit made in
 * the pane) is left as it is. `detail` is for this PC's log only.
 */

/** Windows MAX_PATH, as spawnWorktree's guard. */
const WINDOWS_PATH_MAX = 260;
/** The fetch talks to origin; everything else is local. */
const FETCH_TIMEOUT_MS = 120_000;
const DETAIL_MAX = 500;

export interface ContinueWorktreeInput {
  /** The matched root's realpath: a git repository's top level. */
  repoPath: string;
  /** The request's origin key (originUrlRepoKey). */
  origin: string;
  branch: string;
  head: string;
  /** The conversation's folder below the top level ('' = the top level); parsed already. */
  sub: string;
  continueId: string;
}

/** What a start made, for its undo. */
export interface ContinueWorktreeMade {
  repoPath: string;
  continueId: string;
  branch: string;
  head: string;
  /** The branch's tip before this start moved it; null when this start made it. */
  oldTip: string | null;
}

export type ContinueWorktreeCode = Extract<A2aContinueStartFailure, 'failed' | 'branch-not-found' | 'branch-busy' | 'head-missing' | 'diverged' | 'path-too-long'>;

export type ContinueWorktreeResult =
  | { ok: true; worktreePath: string; cwd: string; made: ContinueWorktreeMade }
  | { ok: false; code: ContinueWorktreeCode; detail: string };

export interface ContinueWorktreeOptions extends SpawnWorktreeOptions {
  platform?: NodeJS.Platform;
}

export async function createContinueWorktree(input: ContinueWorktreeInput, opts: ContinueWorktreeOptions = {}): Promise<ContinueWorktreeResult> {
  const fail = (code: ContinueWorktreeCode, detail: string): ContinueWorktreeResult => ({ ok: false, code, detail: detail.slice(0, DETAIL_MAX) });
  const { repoPath: repo, branch, head, continueId } = input;
  if (!isContinueId(continueId) || !isContinueBranch(branch) || !isContinueCommit(head)) return fail('failed', 'not a continue request\'s id, branch or commit');
  const git = gitRunner(repo, opts);
  // The network calls: no credential prompt (nobody is at a terminal), and
  // more time. GIT_TERMINAL_PROMPT does not cover ssh, which prompts on
  // /dev/tty; an ssh command already set in the environment wins
  // (TaskWorktreeManager's runGit).
  const seen = { ...getExecEnv(), ...(opts.env ?? {}) };
  const noPrompt = { GIT_TERMINAL_PROMPT: '0', ...(!seen.GIT_SSH_COMMAND && !seen.GIT_SSH ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}) };
  const net = gitRunner(repo, { ...opts, env: { ...(opts.env ?? {}), ...noPrompt }, timeoutMs: FETCH_TIMEOUT_MS });

  // 1. The repository's top level, as given.
  const repoReal = await realpathOrNull(repo);
  if (repoReal === null || !samePath(repoReal, repo)) return fail('failed', `${repo} is not its own realpath`);
  const top = await git(['rev-parse', '--show-toplevel']);
  const topReal = top.code === 0 ? await realpathOrNull(top.stdout.trim()) : null;
  if (topReal === null || !samePath(topReal, repo)) return fail('failed', `${repo} is not a git repository's top level`);

  // 2. Config, every scope: the repository's own may name no program, file or
  // URL rewrite; origin is still the request's repository; every filter
  // driver is emptied for the checkout.
  const conf = await git(['config', '-z', '--list', '--show-scope']);
  if (conf.code !== 0) return fail('failed', `git config --list failed: ${conf.stderr.trim()}`);
  const entries = parseGitConfigList(conf.stdout);
  const refusal = workerGitConfigRefusal(entries);
  if (refusal) return fail('failed', refusal);
  const url = originUrlFromConfigList(conf.stdout);
  if (!url || originUrlRepoKey(url) !== input.origin) return fail('failed', 'origin is not the repository the request names');
  const fetchRefusal = taskFetchConfigRefusal(entries, url);
  if (fetchRefusal) return fail('failed', fetchRefusal);
  const noFilters = filterEmptying(filterDriverNames(conf.stdout));
  if (!noFilters) return fail('failed', 'a filter driver name holds \'=\', which -c cannot empty');
  const noSubmodules = ['-c', 'submodule.recurse=false'];
  const ownBefore = ownConfig(conf.stdout, branch);

  // 3. Where it goes.
  let root: string;
  try {
    const wanted = opts.worktreesRoot ?? path.join(getWmuxHomeDir(), 'worktrees');
    fs.mkdirSync(wanted, { recursive: true });
    const real = await realpathOrNull(wanted);
    if (real === null) throw new Error(`${wanted} does not resolve`);
    root = real;
  } catch (err) {
    return fail('failed', `the worktrees folder is not usable: ${(err as Error).message}`);
  }
  const worktreePath = path.join(root, `continue-${continueId}`);
  const cwdPath = input.sub ? path.join(worktreePath, ...input.sub.split('/')) : worktreePath;
  if ((opts.platform ?? process.platform) === 'win32' && cwdPath.length > WINDOWS_PATH_MAX) {
    return fail('path-too-long', `the worktree's folder exceeds ${WINDOWS_PATH_MAX} characters: ${cwdPath}`);
  }
  // Never clean up what this call did not make.
  if (fs.existsSync(worktreePath)) return fail('failed', `${worktreePath} already exists`);

  // 4. That one branch from origin, and A's commit.
  const ref = `refs/heads/${branch}`;
  const fetched = await net(['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', 'origin', `+${ref}:refs/remotes/origin/${branch}`]);
  if (fetched.code !== 0) {
    // ls-remote exits 2 when origin answered and has no such branch.
    const listed = await net(['ls-remote', '--exit-code', '--heads', 'origin', ref]);
    if (listed.code === 2) return fail('branch-not-found', `origin has no branch ${branch}`);
    return fail('failed', `git fetch failed: ${fetched.stderr.trim()}`);
  }
  const commit = await git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  if (commit.code !== 0 || commit.stdout.trim() !== head) return fail('head-missing', `${head} is not on origin's ${branch}, nor here`);

  // 5. B's branch, at A's commit.
  const tip = await git(['rev-parse', '--verify', '--quiet', ref]);
  let oldTip: string | null = null;
  if (tip.code === 0) {
    oldTip = tip.stdout.trim();
    const list = await git(['worktree', 'list', '--porcelain']);
    if (list.code !== 0) return fail('failed', `git worktree list failed: ${list.stderr.trim()}`);
    if (list.stdout.split('\n').some((line) => line === `branch ${ref}`)) return fail('branch-busy', `${branch} is checked out in a worktree`);
    const ancestor = await git(['merge-base', '--is-ancestor', oldTip, head]);
    if (ancestor.code === 1) return fail('diverged', `${branch} here has commits ${head} lacks`);
    if (ancestor.code !== 0) return fail('failed', `git merge-base failed: ${ancestor.stderr.trim()}`);
    const moved = await git(['update-ref', ref, head, oldTip]);
    if (moved.code !== 0) return fail('failed', `${branch} was not moved: ${moved.stderr.trim()}`);
  } else {
    const made = await git(['update-ref', ref, head, '0'.repeat(head.length)]);
    if (made.code !== 0) return fail('failed', `${branch} was not made: ${made.stderr.trim()}`);
  }
  const made: ContinueWorktreeMade = { repoPath: repo, continueId, branch, head, oldTip };
  const undo = (): Promise<void> => removeContinueWorktree(made, opts);

  // 6. The worktree, no files yet: the config is read again first, as the
  // new worktree sees it (an include of the owner's may apply on its branch).
  const add = await git(['worktree', 'add', '--no-checkout', worktreePath, branch], [...noSubmodules, ...noFilters]);
  if (add.code !== 0) {
    await undo();
    return fail('failed', `git worktree add failed: ${add.stderr.trim()}`);
  }
  const confAfter = await git(['config', '-z', '--list', '--show-scope'], [], worktreePath);
  if (confAfter.code !== 0) {
    await undo();
    return fail('failed', `git config --list failed in the new worktree: ${confAfter.stderr.trim()}`);
  }
  const refusedAfter = workerGitConfigRefusal(parseGitConfigList(confAfter.stdout));
  const noFiltersAfter = filterEmptying(filterDriverNames(confAfter.stdout));
  if (refusedAfter || ownConfig(confAfter.stdout, branch) !== ownBefore || !noFiltersAfter) {
    await undo();
    return fail('failed', refusedAfter ?? 'the repository\'s git config changed while the worktree was made, or names a filter -c cannot empty');
  }
  const checkout = await git(['reset', '--hard', '--no-recurse-submodules', 'HEAD'], [...noSubmodules, ...noFiltersAfter], worktreePath);
  if (checkout.code !== 0) {
    await undo();
    return fail('failed', `checking out the new worktree failed: ${checkout.stderr.trim()}`);
  }

  // 7. The conversation's folder inside it, never through a link out of it.
  const wtReal = await realpathOrNull(worktreePath);
  const cwdReal = await realpathOrNull(cwdPath);
  if (wtReal === null || cwdReal === null || !isBelow(path.relative(wtReal, cwdReal)) || !isDirectory(cwdReal)) {
    await undo();
    return fail('failed', `${input.sub || '.'} is not a folder inside the new worktree`);
  }
  return { ok: true, worktreePath: wtReal, cwd: cwdReal, made };
}

/**
 * Take back what createContinueWorktree made: the worktree, then the branch
 * (deleted when this start made it, else back at its old tip), each only
 * from the value this start left it at.
 */
export async function removeContinueWorktree(made: ContinueWorktreeMade, opts: ContinueWorktreeOptions = {}): Promise<void> {
  if (!isContinueId(made.continueId) || !isContinueBranch(made.branch)) return;
  const git: Git = gitRunner(made.repoPath, opts);
  const root = await realpathOrNull(opts.worktreesRoot ?? path.join(getWmuxHomeDir(), 'worktrees'));
  if (root !== null) {
    const worktreePath = path.join(root, `continue-${made.continueId}`);
    await git(['worktree', 'remove', '--force', worktreePath]);
    await git(['worktree', 'prune']);
    // A folder git no longer knows: removed only as this start's own child of the root.
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* the caller logs what is left */ }
  }
  const ref = `refs/heads/${made.branch}`;
  if (made.oldTip === null) await git(['update-ref', '-d', ref, made.head]);
  else if (made.oldTip !== made.head) await git(['update-ref', ref, made.oldTip, made.head]);
}

/** `-c` options that empty every filter driver for one checkout; null when a name holds '=' (-c cannot name it). */
function filterEmptying(drivers: string[]): string[] | null {
  if (drivers.some((n) => n.includes('='))) return null;
  return drivers.flatMap((n) => ['smudge=', 'clean=', 'process=', 'required=false'].flatMap((v) => ['-c', `filter.${n}.${v}`]));
}
