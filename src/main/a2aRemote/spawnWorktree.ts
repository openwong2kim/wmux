import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getWmuxHomeDir } from '../../shared/constants';
import { getExecEnv } from '../../shared/execEnv';
import { resolveExecutable } from '../../shared/exeSearch';
import { isSpawnId } from '../../shared/a2aSpawn';
import { parseGitConfigList, urlNamedRemoteRefusal, workerGitConfigRefusal, workerGitEnv, workerGitSafeArgs, workerOriginRefusal, type GitConfigEntry } from '../worktask/workerGit';

/**
 * The fresh worktree a remote spawn's agent works in: another paired PC asked
 * this PC to start an agent in folder `sub` of an allowed repository, and
 * the agent gets its own branch `wmux/remote/<spawnId>` under the worktrees
 * root, checked out from origin's default branch as fetched now (origin/HEAD,
 * else main, else master): this PC's own checkout may be on any branch, and
 * old. When it cannot be fetched (offline, no origin, a config main does not
 * fetch with) the branch starts at HEAD, and `baseNote` says why.
 *
 * The repository's own config may have been written by an agent that worked
 * in it before, so the checkout runs nothing that config names: no hooks, no
 * fsmonitor (workerGitSafeArgs), and no content filter. A repository whose
 * own config defines a filter or includes another file is refused (an
 * include can define a filter only once the new branch exists, through
 * `includeIf.onbranch`). Filters the owner's global or system config defines
 * (git-lfs) are emptied on the command line for this one checkout.
 *
 * `detail` is for this PC's log only.
 */

const execFileAsync = promisify(execFile);

/** Windows MAX_PATH guard, as TaskWorktreeManager's. */
const MAX_WORKTREE_PATH_LEN = 260;
const GIT_TIMEOUT_MS = 30_000;
const DETAIL_MAX = 500;
/** Each network call of the base (the remote's HEAD, the fetch): short, so an offline PC falls back to HEAD soon. */
export const SPAWN_BASE_FETCH_TIMEOUT_MS = 15_000;

export interface SpawnWorktreeInput {
  /** realpath of an allowed root; must be a git repository's top level */
  repoPath: string;
  /** normalized relative POSIX path below it ('' = the root); already validated to have no '..', no leading '/', no backslash */
  sub: string;
  /** 'sp-<uuid>' */
  spawnId: string;
}

export type SpawnWorktreeResult =
  | {
    ok: true; worktreePath: string; cwd: string; branch: string;
    /** The commit the branch starts at. */
    base: string;
    /** `origin/<default>` when the base is origin's default branch, fetched now. */
    baseRef?: string;
    /** Why the base is this PC's HEAD instead (not fetched, or the fetch failed). */
    baseNote?: string;
  }
  | { ok: false; code: 'folder-not-allowed' | 'failed'; detail: string };

export interface SpawnWorktreeOptions {
  /** Default: `<wmux home>/worktrees`, as TaskWorktreeManager's. */
  worktreesRoot?: string;
  /** Default: `<wmux home>/factory/no-hooks`, the folder every main-side
   *  worker git call points core.hooksPath at (it need not exist). */
  noHooksDir?: string;
  /** Test seam: added to git's environment. */
  env?: Record<string, string>;
}

export interface GitOut { code: number; stdout: string; stderr: string }

/** Local or worktree config keys that refuse the repository. */
const REFUSED_OWN_KEYS = /^(?:filter|include|includeif)\./;

export async function createSpawnWorktree(input: SpawnWorktreeInput, opts: SpawnWorktreeOptions = {}): Promise<SpawnWorktreeResult> {
  const notAllowed = (detail: string): SpawnWorktreeResult => ({ ok: false, code: 'folder-not-allowed', detail });
  const failed = (detail: string): SpawnWorktreeResult => ({ ok: false, code: 'failed', detail: detail.slice(0, DETAIL_MAX) });
  if (!isSpawnId(input.spawnId)) return failed('the spawn id is not sp-<uuid>');

  const repo = input.repoPath;
  const git = gitRunner(repo, opts);

  // 1. The repository's top level, as given.
  const repoReal = await realpathOrNull(repo);
  if (repoReal === null || !samePath(repoReal, repo)) return notAllowed(`${repo} is not its own realpath`);
  const top = await git(['rev-parse', '--show-toplevel']);
  const topReal = top.code === 0 ? await realpathOrNull(top.stdout.trim()) : null;
  if (topReal === null || !samePath(topReal, repo)) return notAllowed(`${repo} is not a git repository's top level`);

  // 2–3. Config, every scope, includes resolved: the repository's own may
  // define no filter and include nothing; every driver name is emptied below.
  const conf = await git(['config', '-z', '--list', '--show-scope']);
  if (conf.code !== 0) return failed(`git config --list failed: ${conf.stderr.trim()}`);
  const own = parseGitConfigList(conf.stdout).find((e) => (e.scope === 'local' || e.scope === 'worktree') && REFUSED_OWN_KEYS.test(e.key));
  if (own) return notAllowed(`the repository's git config sets ${own.key}`);
  const drivers = filterDriverNames(conf.stdout);
  const odd = drivers.find((n) => n.includes('='));
  if (odd !== undefined) return notAllowed(`a filter driver name holds '=' (${odd}), which -c cannot empty`);
  const noFilters = drivers.flatMap((n) => ['smudge=', 'clean=', 'process=', 'required=false'].flatMap((v) => ['-c', `filter.${n}.${v}`]));
  // Nor does the checkout descend into submodules (their own config is not checked here).
  const noSubmodules = ['-c', 'submodule.recurse=false'];
  // The new branch tracks nothing, so the add writes no branch.<name>.* keys
  // into the repository's config (a global autoSetupMerge would).
  const noTracking = ['-c', 'branch.autoSetupMerge=false'];
  const ownBefore = ownConfig(conf.stdout, branchFor(input.spawnId));

  // 4. The worktree.
  let root: string;
  try {
    const wanted = opts.worktreesRoot ?? path.join(getWmuxHomeDir(), 'worktrees');
    fs.mkdirSync(wanted, { recursive: true });
    const real = await realpathOrNull(wanted);
    if (real === null) throw new Error(`${wanted} does not resolve`);
    root = real;
  } catch (err) {
    return failed(`the worktrees folder is not usable: ${(err as Error).message}`);
  }
  const worktreePath = path.join(root, `remote-${input.spawnId}`);
  const branch = branchFor(input.spawnId);
  if (worktreePath.length > MAX_WORKTREE_PATH_LEN) return failed(`worktree path exceeds ${MAX_WORKTREE_PATH_LEN} characters: ${worktreePath}`);
  // Never clean up what this call did not make.
  if (fs.existsSync(worktreePath)) return failed(`${worktreePath} already exists`);
  if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) return failed(`branch ${branch} already exists`);

  const undo = (): Promise<void> => removeWorktree(git, root, worktreePath, branch);

  // The base: origin's default branch, fetched now, else HEAD.
  const base = await resolveSpawnBase(repo, opts, git, parseGitConfigList(conf.stdout));

  // No files yet: the config is read again first, as the new worktree sees it.
  const add = await git(['worktree', 'add', '--no-checkout', '--no-track', '-b', branch, worktreePath, base.commit], [...noSubmodules, ...noTracking, ...noFilters]);
  if (add.code !== 0) {
    await undo();
    return failed(`git worktree add failed: ${add.stderr.trim()}`);
  }

  // 4b. On its own branch an `includeIf.onbranch` may now apply. The
  // repository's own config must be what was checked (nothing changed it
  // meanwhile) and still refuse nothing; every filter driver it now sees is
  // emptied for the checkout, which only then writes the files.
  const confAfter = await git(['config', '-z', '--list', '--show-scope'], [], worktreePath);
  if (confAfter.code !== 0) {
    await undo();
    return failed(`git config --list failed in the new worktree: ${confAfter.stderr.trim()}`);
  }
  const refusedAfter = parseGitConfigList(confAfter.stdout).find((e) => (e.scope === 'local' || e.scope === 'worktree') && REFUSED_OWN_KEYS.test(e.key));
  if (ownConfig(confAfter.stdout, branch) !== ownBefore || refusedAfter) {
    await undo();
    return notAllowed(refusedAfter ? `the new worktree's git config sets ${refusedAfter.key}` : 'the repository\'s git config changed while the worktree was made');
  }
  const driversAfter = filterDriverNames(confAfter.stdout);
  const oddAfter = driversAfter.find((n) => n.includes('='));
  if (oddAfter !== undefined) {
    await undo();
    return notAllowed(`a filter driver name holds '=' (${oddAfter}), which -c cannot empty`);
  }
  const noFiltersAfter = driversAfter.flatMap((n) => ['smudge=', 'clean=', 'process=', 'required=false'].flatMap((v) => ['-c', `filter.${n}.${v}`]));
  const checkout = await git(['reset', '--hard', '--no-recurse-submodules', 'HEAD'], [...noSubmodules, ...noFiltersAfter], worktreePath);
  if (checkout.code !== 0) {
    await undo();
    return failed(`checking out the new worktree failed: ${checkout.stderr.trim()}`);
  }

  // 5. The folder inside it, never through a link out of it.
  const wtReal = await realpathOrNull(worktreePath);
  const cwdReal = await realpathOrNull(input.sub === '' ? worktreePath : path.join(worktreePath, ...input.sub.split('/')));
  let inside = false;
  if (wtReal !== null && cwdReal !== null) {
    const rel = path.relative(wtReal, cwdReal);
    inside = isBelow(rel) && isDirectory(cwdReal);
  }
  if (!inside || wtReal === null || cwdReal === null) {
    await undo();
    return notAllowed(`${input.sub || '.'} is not a folder inside the new worktree`);
  }
  return { ok: true, worktreePath: wtReal, cwd: cwdReal, branch, base: base.commit, ...(base.ref ? { baseRef: base.ref } : {}), ...(base.note ? { baseNote: base.note } : {}) };
}

/** A default branch name as origin may name it: plain, never an option or a range. */
const BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Where a spawn's branch starts: origin's default branch, fetched now
 * (`origin/HEAD`, else `origin/main`, else `origin/master`, else the remote's
 * own HEAD), pinned to one commit. Fetched only when the repository's own
 * config names nothing git would run or connect through (workerGitConfigRefusal),
 * origin holds only its URL and refspec, and no remote or bundle URI would
 * stand in for it. Every network call has SPAWN_BASE_FETCH_TIMEOUT_MS, no
 * prompt, and ssh in batch mode unless the owner set their own ssh command.
 * Anything else: HEAD, with the reason in `note`. Never throws.
 */
async function resolveSpawnBase(repo: string, opts: SpawnWorktreeOptions, git: Git, entries: readonly GitConfigEntry[]): Promise<{ commit: string; ref?: string; note?: string }> {
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const headCommit = head.code === 0 ? head.stdout.trim() : 'HEAD';
  const fallback = (why: string): { commit: string; note: string } => ({
    commit: headCommit,
    note: `${why.slice(0, DETAIL_MAX)}; branched from this PC's HEAD, which may not be origin's default branch`,
  });

  const refused = workerGitConfigRefusal(entries);
  if (refused) return fallback(`origin was not fetched: ${refused}`);
  const origin = workerOriginRefusal(entries);
  if ('error' in origin) return fallback(`origin was not fetched: ${origin.error}`);
  const named = urlNamedRemoteRefusal(entries, origin.url);
  if (named) return fallback(`origin was not fetched: ${named}`);
  const bundle = entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && (/^(?:fetch|transfer)\.bundleuri$/.test(e.key) || e.key.startsWith('bundle.')));
  if (bundle) return fallback(`origin was not fetched: the repository's git config sets ${bundle.key}`);

  const ownSsh = entries.some((e) => e.key === 'core.sshcommand') || !!process.env.GIT_SSH_COMMAND || !!process.env.GIT_SSH || !!opts.env?.GIT_SSH_COMMAND || !!opts.env?.GIT_SSH;
  const net = gitRunner(repo, {
    ...opts,
    timeoutMs: SPAWN_BASE_FETCH_TIMEOUT_MS,
    env: { ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: '0', ...(ownSsh ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) },
  });

  let name: string | undefined;
  const sym = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0 && sym.stdout.trim().startsWith('refs/remotes/origin/')) name = sym.stdout.trim().slice('refs/remotes/origin/'.length);
  for (const candidate of ['main', 'master']) {
    if (name) break;
    if ((await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}^{commit}`])).code === 0) name = candidate;
  }
  if (!name) {
    const remote = await net(['ls-remote', '--symref', 'origin', 'HEAD']);
    if (remote.code !== 0) return fallback(`origin's default branch could not be read (${remote.stderr.trim() || `exit ${remote.code}`})`);
    name = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote.stdout)?.[1];
  }
  if (!name || !BRANCH_NAME_RE.test(name)) return fallback(name ? `origin's default branch name ${JSON.stringify(name.slice(0, 80))} was not used` : 'origin names no default branch');

  const ref = `refs/remotes/origin/${name}`;
  const fetched = await net(['fetch', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', 'origin', `+refs/heads/${name}:${ref}`]);
  if (fetched.code !== 0) return fallback(`git fetch origin ${name} failed (${fetched.stderr.trim() || `exit ${fetched.code}`})`);
  const pinned = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (pinned.code !== 0) return fallback(`${ref} does not exist after git fetch origin ${name}`);
  return { commit: pinned.stdout.trim(), ref: `origin/${name}` };
}

/**
 * Take back a worktree `createSpawnWorktree` made, and its branch: the start
 * it was for did not finish. Only `<worktrees root>/remote-<spawnId>` and
 * `wmux/remote/<spawnId>` are touched.
 */
export async function removeSpawnWorktree(input: { repoPath: string; spawnId: string }, opts: SpawnWorktreeOptions = {}): Promise<void> {
  if (!isSpawnId(input.spawnId)) return;
  const root = await realpathOrNull(opts.worktreesRoot ?? path.join(getWmuxHomeDir(), 'worktrees'));
  if (root === null) return;
  await removeWorktree(gitRunner(input.repoPath, opts), root, path.join(root, `remote-${input.spawnId}`), branchFor(input.spawnId));
}

/** The branch a spawn's worktree is on. */
export function branchFor(spawnId: string): string {
  return `wmux/remote/${spawnId}`;
}

export type Git = (args: string[], pre?: string[], at?: string) => Promise<GitOut>;

/** git with the worker hardening, in `repo` (or `at`); `pre`: further `-c` options, after the safe ones. `timeoutMs`: each call's limit (default GIT_TIMEOUT_MS). */
export function gitRunner(repo: string, opts: SpawnWorktreeOptions & { timeoutMs?: number }): Git {
  const env = workerGitEnv({ ...getExecEnv(), ...(opts.env ?? {}) });
  const gitExe = resolveExecutable('git', { env });
  const safe = workerGitSafeArgs(path.resolve(opts.noHooksDir ?? path.join(getWmuxHomeDir(), 'factory', 'no-hooks')));
  return async (args, pre = [], at = repo) => {
    try {
      const { stdout, stderr } = await execFileAsync(gitExe, [...safe, ...pre, '-C', at, ...args], {
        cwd: at,
        env,
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.killed ? 'timed out' : (e.stderr || String(err)) };
    }
  };
}

async function removeWorktree(git: Git, root: string, worktreePath: string, branch: string): Promise<void> {
  // Twice: a `worktree add` that was cut leaves its worktree locked ("initializing").
  await git(['worktree', 'remove', '--force', '--force', worktreePath]);
  await git(['worktree', 'prune']);
  await git(['branch', '-D', branch]);
  // A folder git no longer knows: removed only as a plain child of the root.
  const rel = path.relative(root, worktreePath);
  if (rel && isBelow(rel) && !rel.includes(path.sep)) {
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* reported by the caller's detail */ }
  }
}

/**
 * The repository's own config (local scope, shared by its worktrees), as one
 * comparable string. Keys of `except` (the new branch's own `branch.<name>.*`,
 * which git may write for it) are left out.
 */
export function ownConfig(stdout: string, except?: string): string {
  const own = except ? `branch.${except.toLowerCase()}.` : undefined;
  return parseGitConfigList(stdout)
    .filter((e) => e.scope === 'local' && !(own && e.key.startsWith(own)))
    .map((e) => `${e.scope}\0${e.key}\0${e.value}`)
    .join('\n');
}

/** Every filter driver name in `git config -z --list --show-scope` output,
 *  as written: a subsection keeps its case and may hold dots. */
export function filterDriverNames(stdout: string): string[] {
  const names = new Set<string>();
  const parts = stdout.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n');
    const key = nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl);
    const last = key.lastIndexOf('.');
    if (/^filter\./i.test(key) && last > 'filter.'.length) names.add(key.slice('filter.'.length, last));
  }
  return [...names];
}

/** A `path.relative` result that stays at or below its base (a name like
 *  `..foo` is below it). */
export function isBelow(rel: string): boolean {
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** The OS realpath: on Windows it expands 8.3 short names, as the root it is compared with was. */
export async function realpathOrNull(p: string): Promise<string | null> {
  return new Promise((resolve) => fs.realpath.native(p, (err, real) => resolve(err ? null : real)));
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
