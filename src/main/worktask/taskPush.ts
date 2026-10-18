// ─── task.push — main pushes a worker's own task branch ─────────────────────
//
// A bot's fan-out worker may not run `git push` itself (its deny rules refuse
// every form, shared/botWorkerGuard.ts). Its branch reaches the remote here,
// from main, with a fixed shape the worker cannot change:
//
//   - WHICH branch: the task's own branch, from main's task record (the
//     worker's verified pane → its task workspace → the open ledger row →
//     the WorkTask main created). Never a name from the wire.
//   - WHICH repository: the git dir and the worktree git dir main recorded for
//     the task at dispatch (LedgerDispatch.gitCommonDir / gitWorktreeDir).
//     Main reads the repository config and the worktree's HEAD by those paths
//     (never discovered through the worktree) and writes nothing under them.
//   - WHERE: origin's URL, read from that repository's config and pushed to
//     as a URL (not through the remote's name). Refused when origin sets
//     anything but its URL and fetch refspec, when any URL rewrite or a
//     program-running key is set (worktask/workerGit.ts), when the config
//     defines a remote named by origin's URL (the same remote and ref checks
//     as task_fetch), when the URL is not a plain https/ssh address of the
//     task's recorded repository, and when it does not match the origin pin
//     main recorded for the task (shared/originPin.ts: the form, user, host
//     and port exactly; a row with no pin is pinned at its first use only
//     when origin names no other port than its default). Every network call
//     then uses the pinned URL as recorded, never a respelling of it.
//   - IN WHICH git dir: the push runs in a bare relay repository main owns
//     (one per task, under <wmux>/factory/git-relay/<taskId>) that borrows the
//     recorded repository's objects through `objects/info/alternates`. The
//     pushed commit is read from the recorded objects through that link; main
//     writes nothing under the recorded repository. git in the relay reads the
//     owner's system and global config, the relay's own config (origin's URL,
//     written by main) and the `-c` options below — never the task
//     repository's config.
//   - HOW: fast-forward only (no force, no `+`), the branch alone (no tags
//     follow it, no submodule is pushed), never onto a default branch
//     (main/master, every default branch main recorded, and the repository's
//     own), never for a task on a detached checkout (the verify preset grades
//     a commit; it has no branch to publish).
//   - main's git runs with no fsmonitor and the worktree's own hooks do not
//     run (`core.hooksPath` pointed at an empty folder, `--no-verify`).
//   - IN WHICH git: on Windows, a task whose recorded repository lives inside
//     a WSL distro is pushed by that distro's own git, through `wsl.exe -d
//     <distro> --exec git` (argv only, no shell); the relay lives on the
//     distro's view of main's folder. A path under a WSL host whose distro or
//     path cannot be read is refused, never guessed.
//   - The repository's own default branch is refused under every name it is
//     read by: GitHub's (by key), origin/HEAD, and the remote's own HEAD
//     (`ls-remote --symref` at the pushed URL).
//
// Any fan-out worker may call it; for a bot's worker it is the only way to
// publish. Afterwards the worker runs `gh pr create --head <branch>`; main
// writes no upstream ref.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { mergeWslEnv } from '../../shared/wsl';
import { decodeWslOutput, isValidWslDistroName } from '../../shared/wslDistro';
import { BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import { namesNonDefaultPort, originPinMatches, parseOriginAddress } from '../../shared/originPin';
import {
  RELAY_GIT_DEFAULT_PROTOCOLS, gitVersionRefusal, lazyFetchProbeRefusal, parseRawGitConfigList, parseTaskHead, relayGitConfigArgs, taskGitEnv, transportConfigReplay,
} from '../../shared/taskGitRelay';
import { readWorkerFile } from '../../shared/readWorkerFile';
import { originUrlRepoKey, urlNamedRemoteRefusal, workerGitEnv, workerGitPreflight, workerGitSafeArgs, workerOriginRefusal, type GitConfigEntry } from './workerGit';

const execFileP = promisify(execFile);

export const TASK_PUSH_TIMEOUT_MS = 120_000;

type GitOut = { code: number; stdout: string; stderr: string };

/** Runs git in `cwd` with `env` added; resolves with the exit code and
 *  output, never throws. */
export type TaskPushGit = (args: string[], cwd: string, env?: Record<string, string>, opts?: { timeoutMs?: number }) => Promise<GitOut>;

/** Where main's git finds the task's repository: main's records only. */
export interface TaskGitRepoInput {
  /** The task's worktree (main's record). */
  worktreePath: string;
  /** The task repository's git dir main recorded at dispatch (its common
   *  dir, resolved). */
  gitCommonDir: string;
  /** The task worktree's own git dir main recorded at dispatch
   *  (`<common>/worktrees/<id>`); needed only to read HEAD for a push. */
  gitWorktreeDir?: string;
  /** An empty folder for `core.hooksPath`. */
  noHooksDir: string;
  /** Main's folder for relay repositories (`<wmux>/factory/git-relay`). */
  relayRoot: string;
  /** The task's id (names its relay). */
  taskId: string;
}

/** The origin address main recorded for the task (shared/originPin.ts). */
export interface TaskOriginPinInput {
  /** The pin origin must match; absent for a row written before pins. */
  expectedOriginPin?: string;
  /** With no expected pin: records origin's pin, as read now, on the task's
   *  row and resolves with the pin the row holds (null: not recorded). */
  recordOriginPin?: (pin: string) => Promise<string | null>;
}

/** The URL main's network git uses for the task, or why it uses none. With a
 *  pin: origin's URL must name the pinned address, and the network calls
 *  then use the pin itself, as recorded, so a respelling of origin changes
 *  nothing git connects to (URL rewrites and URL-scoped settings match the
 *  string literally). With none and `recordOriginPin` given (a row written
 *  before pins): origin's URL is pinned, only when its repository key was
 *  checked and it names no port other than its transport's default; a pin
 *  that could not be recorded refuses. Never throws. */
export async function originPinUrl(url: string, input: TaskOriginPinInput & { expectedRepoKey?: string }): Promise<{ url: string } | { error: string }> {
  const pin = input.expectedOriginPin;
  if (pin === undefined) {
    if (!input.recordOriginPin) return { url };
    const a = parseOriginAddress(url);
    if (!a || input.expectedRepoKey === undefined || namesNonDefaultPort(a)) return { error: 'wmux recorded no origin address for this task that it can confirm; start a new task for this repository' };
    const stored = await input.recordOriginPin(url).catch(() => null);
    return stored === url ? { url } : { error: 'wmux could not record origin\'s address for this task' };
  }
  if (!originPinMatches(pin, url)) return { error: 'origin does not match the address wmux recorded for this task' };
  return { url: pin };
}

export interface TaskPushInput extends TaskGitRepoInput, TaskOriginPinInput {
  /** The task's branch (main's record). */
  branch: string;
  /** Default branches main recorded for this instance (main/master are
   *  always added). */
  defaultBranches: readonly string[];
  /** A bot's task: the repository the push must land in (`host/owner/repo`
   *  or `owner/repo`). Absent for a task of the operator's. */
  expectedRepoKey?: string;
  /** The repository's own default branch, read by its key (never from the
   *  worktree). */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
}

export type TaskPushResult =
  | { ok: true; branch: string; remote: 'origin'; head: string; output: string }
  | { ok: false; reason: 'branch-refused' | 'no-origin' | 'remote-refused' | 'config-refused' | 'rejected' | 'git-failed'; error: string };

export async function defaultGit(args: string[], cwd: string, extra?: Record<string, string>, opts?: { timeoutMs?: number }): Promise<GitOut> {
  const env = { ...workerGitEnv(getExecEnv()), GIT_TERMINAL_PROMPT: '0', ...extra };
  try {
    const timeout = Math.max(1, Math.min(opts?.timeoutMs ?? TASK_PUSH_TIMEOUT_MS, TASK_PUSH_TIMEOUT_MS));
    const { stdout, stderr } = await execFileP('git', args, { cwd, env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' && e.stderr ? e.stderr : (e.message ?? String(err)),
    };
  }
}

/** Why main will not push this branch, or null. Pure. */
export function taskPushBranchRefusal(branch: string, defaultBranches: readonly string[]): string | null {
  if (!isDenyableBranchName(branch)) return 'the task branch name cannot be pushed as itself';
  const defaults = new Set([...BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, ...defaultBranches]);
  if (defaults.has(branch)) return `the task branch ${branch} is a default branch; main never pushes onto one`;
  return null;
}

/** The git argv of main's push (after the safe `-c` options): the commit
 *  `sha` HEAD was resolved to, never `HEAD` itself. Pure. */
export function taskPushArgs(branch: string, url: string, sha: string): string[] {
  return ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', '--', url, `${sha}:refs/heads/${branch}`];
}

/** Which git serves a task: main's own, or a WSL distro's. */
export type TaskPushGitTarget =
  | { kind: 'host' }
  | { kind: 'wsl'; distro: string; gitDir: string }
  | { kind: 'refused'; error: string };

const WSL_GITDIR_RE = /^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]([^\\/]*)(.*)$/i;

/** The git that serves a worktree, from its `.git` file's text (null: a
 *  `.git` folder or none). Only on Windows is a gitdir under a WSL host a
 *  distro's; its Linux path must be absolute and plain. Pure. */
export function taskPushGitTarget(dotGit: string | null, platform: NodeJS.Platform = process.platform): TaskPushGitTarget {
  if (platform !== 'win32' || dotGit === null) return { kind: 'host' };
  const line = /^gitdir:[ \t]*(.*?)[ \t]*$/m.exec(dotGit.replace(/\r/g, ''));
  if (!line) return { kind: 'host' };
  return taskGitDirTarget(line[1], platform);
}

/** The git that runs on a git dir at `dir` (a path main recorded): on
 *  Windows, a path under a WSL host is that distro's. Pure. */
export function taskGitDirTarget(dir: string, platform: NodeJS.Platform = process.platform): TaskPushGitTarget {
  if (platform !== 'win32') return { kind: 'host' };
  const m = WSL_GITDIR_RE.exec(dir);
  if (!m) return { kind: 'host' };
  const distro = m[1];
  if (!isValidWslDistroName(distro)) {
    return { kind: 'refused', error: `the task's repository is inside WSL, but the distro in its gitdir (${JSON.stringify(dir.slice(0, 300))}) cannot be read` };
  }
  const gitDir = m[2].replace(/\\/g, '/');
  const segs = gitDir.split('/').slice(1);
  // eslint-disable-next-line no-control-regex
  if (!gitDir.startsWith('/') || segs.some((s) => !s || s === '.' || s === '..') || /[\x00-\x1f\x7f]/.test(gitDir)) {
    return { kind: 'refused', error: `the task's repository is inside WSL distro ${distro}, but its gitdir path (${JSON.stringify(dir.slice(0, 300))}) cannot be used` };
  }
  return { kind: 'wsl', distro, gitDir };
}

/** Runs `file` with `args`; resolves with the exit code and output, never
 *  throws. */
export type TaskPushExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<GitOut>;

async function defaultWslExec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitOut> {
  const opts = { cwd: os.homedir(), env, timeout: TASK_PUSH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' as const };
  try {
    const { stdout, stderr } = await execFileP(file, args, opts);
    return { code: 0, stdout: stdout.toString('utf8'), stderr: decodeWslOutput(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    let stderr = Buffer.isBuffer(e.stderr) && e.stderr.length > 0 ? decodeWslOutput(e.stderr).trim() : '';
    if (!stderr && Buffer.isBuffer(e.stdout) && e.stdout.length > 0) stderr = decodeWslOutput(e.stdout).trim();
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : '',
      stderr: stderr || (e.message ?? String(err)),
    };
  }
}

function wslExePath(systemRoot: string | undefined): string {
  return path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
}

/** The env of a wsl.exe run: `extra` reaches the distro only by name in
 *  WSLENV (its values are Linux paths and text, so no `/p`), and git's own
 *  variables are never forwarded from main's environment. */
function wslEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = workerGitEnv(getExecEnv());
  const forwarded = (base.WSLENV ?? '').split(':').filter((n) => n && !/^GIT_/i.test(n.split('/')[0])).join(':');
  const add = { GIT_TERMINAL_PROMPT: '0', ...extra };
  return { ...base, ...add, WSL_UTF8: '1', WSLENV: mergeWslEnv(forwarded, Object.keys(add)) };
}

/** The wsl.exe argv that runs `git <args>` on a gitdir inside a distro. Pure. */
export function wslGitArgv(distro: string, gitDir: string, args: readonly string[]): string[] {
  return ['-d', distro, '--cd', '/', '--exec', 'git', `--git-dir=${gitDir}`, ...args];
}

/** A TaskPushGit that runs inside a WSL distro on its gitdir (the `cwd` it is
 *  handed — a Windows path — is not used). */
export function wslTaskPushGit(distro: string, gitDir: string, exec: TaskPushExec = defaultWslExec, systemRoot = process.env.SystemRoot): TaskPushGit {
  const wslExe = wslExePath(systemRoot);
  return (args, _cwd, extra) => exec(wslExe, wslGitArgv(distro, gitDir, args), wslEnv(extra));
}

export interface TaskPushDeps {
  platform?: NodeJS.Platform;
  /** Runs wsl.exe (a WSL distro's git). */
  wslExec?: TaskPushExec;
  /** The transports a network call may use (default https and ssh). */
  protocols?: readonly string[];
  /** A Windows path as the task's WSL distro sees it (default: ask the distro
   *  with `wslpath`). */
  toWslPath?: (windowsPath: string) => string | Promise<string | null> | null;
}

/** `ls-remote --symref` output → the remote HEAD's branch, or null. Pure. */
export function parseLsRemoteHead(stdout: string): string | null {
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout.replace(/\r/g, ''));
  return m ? m[1] : null;
}

/** Main's git on a task's recorded repository and its relay. */
export interface TaskGitRepo {
  /** The repository config, read through `--git-dir` (includes resolved). */
  entries: GitConfigEntry[];
  /** A read on the recorded repository (`--git-dir`, no object or ref write). */
  local: (args: string[]) => Promise<GitOut>;
  /** The commit the worktree's HEAD names: its HEAD file in the recorded
   *  worktree git dir, read strictly (parseTaskHead), a branch resolved in
   *  the recorded repository's refs. No object is read. Fails when main
   *  recorded no worktree git dir. */
  headOid: () => Promise<{ ok: true; oid: string } | { ok: false; error: string }>;
  /** `fn` runs git in the task's relay (origin set to `url`, objects borrowed
   *  from the recorded repository). Never throws. */
  inRelay: <T>(url: string, fn: (run: (args: string[]) => Promise<GitOut>) => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; error: string }>;
  /** The relay path the worker's shell reads it by (a Linux path in WSL). */
  relayShellPath: string;
  /** The platform whose shell runs the fetch line (a WSL distro is 'linux'). */
  workerShellPlatform: NodeJS.Platform;
  /** The recorded repository lives in a WSL distro (its relay borrows objects
   *  by a Linux path). */
  inWslDistro: boolean;
}

const TASK_ID_RE = /^[A-Za-z0-9_.-]+$/;

/** The most of a shallow list main reads (about 25,000 boundary commits). */
const SHALLOW_MAX = 1024 * 1024;

/** Serializes calls that touch one relay (the no-changes check and task_fetch
 *  can reach the same relay at once). */
const relayLocks = new Map<string, Promise<unknown>>();
function withRelayLock<T>(relayHostPath: string, fn: () => Promise<T>): Promise<T> {
  const prior = relayLocks.get(relayHostPath) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  relayLocks.set(relayHostPath, next.then(() => undefined, () => undefined));
  return next;
}

export { readWorkerFile };

/** Whether anything is at `p` (a dangling symlink counts); null when that
 *  cannot be told. */
async function hostPathPresent(p: string): Promise<boolean | null> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
}

async function wslPathPresent(exec: TaskPushExec, distro: string, linuxPath: string): Promise<boolean | null> {
  const wslExe = wslExePath(process.env.SystemRoot);
  const r = await exec(wslExe, ['-d', distro, '--cd', '/', '--exec', 'test', '-e', linuxPath, '-o', '-h', linuxPath], wslEnv());
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** readWorkerFile inside a WSL distro: a plain file only, at most `max`
 *  bytes, given a few seconds. It runs in a child process, so main never
 *  waits on it past that timeout; callers parse its text strictly and never
 *  echo it back. */
async function wslReadFile(exec: TaskPushExec, distro: string, linuxPath: string, max = 4096): Promise<string | null> {
  const wslExe = wslExePath(process.env.SystemRoot);
  const isFile = await exec(wslExe, ['-d', distro, '--cd', '/', '--exec', 'test', '-f', linuxPath, '-a', '!', '-h', linuxPath], wslEnv());
  if (isFile.code !== 0) return null;
  const r = await exec(wslExe, ['-d', distro, '--cd', '/', '--exec', 'timeout', '5', 'head', '-c', String(max + 1), '--', linuxPath], wslEnv());
  return r.code === 0 && Buffer.byteLength(r.stdout, 'utf8') <= max ? r.stdout : null;
}

function hostRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** How long the GIT_NO_LAZY_FETCH capability check may run, everything it
 *  runs together. */
export const LAZY_FETCH_PROBE_TIMEOUT_MS = 20_000;

/** How long removing the check's temp folder may take. */
const LAZY_FETCH_PROBE_CLEANUP_MS = 10_000;

/** The sha1 empty tree (git knows it without reading any object). */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** What the capability check runs with: the task's own runner. Each call is
 *  given the time it has left and stops (its process killed) after it. */
export interface LazyFetchProbeIo {
  /** Which runner: `host`, or `wsl:<distro>`. Part of the cache key. */
  runner: string;
  /** git through that runner, `env` added to taskGitEnv. Never throws. */
  git: (args: string[], env: Record<string, string>, timeoutMs: number) => Promise<GitOut>;
  /** git's own binary in `execPath` (`git --exec-path`) as device, inode,
   *  size and modification time, or null when it cannot be read. */
  binaryId: (execPath: string, timeoutMs: number) => Promise<string | null>;
  /** A new empty folder that git sees, or null when none could be made. */
  makeTempDir: (timeoutMs: number) => Promise<string | null>;
  /** Removes that folder, and nothing else. Never throws. */
  removeTempDir: (dir: string, timeoutMs: number) => Promise<void>;
}

/** Accepted checks (and checks in flight), by runner, git's exec path, the
 *  identity of the git binary there and the `git --version` text. A refusal
 *  is dropped once it resolves, so a fixed git is checked again on the next
 *  call. */
const lazyFetchChecks = new Map<string, Promise<string | null>>();

/** `p`, or `late` once `ms` have passed. */
async function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The capability check for a git whose version is not one known to honour
 * GIT_NO_LAZY_FETCH (gitVersionRefusal): null when it does, else why main
 * will not run a task's git with it. Offline: a throwaway bare repository in a
 * temp folder the runner made, read with no system or global config, a
 * promisor remote at a path inside it that does not exist, and
 * GIT_ALLOW_PROTOCOL=file. Its last call is a diff that needs a blob only the
 * promisor has; `diff -p` prefetches through the promisor code on every
 * version (`cat-file` does not reach it from 2.45.1 on, where
 * GIT_NO_LAZY_FETCH skips the promisor before it is asked). Cached for main's
 * lifetime once accepted. Never throws.
 */
export async function gitLazyFetchRefusal(io: LazyFetchProbeIo, versionStdout: string, safe: readonly string[]): Promise<string | null> {
  const ver = versionStdout.trim().slice(0, 80) || 'git';
  const unchecked = (why: string) => `${ver}: whether it honours GIT_NO_LAZY_FETCH could not be checked (${why})`;
  const deadline = Date.now() + LAZY_FETCH_PROBE_TIMEOUT_MS;
  const left = () => deadline - Date.now();
  try {
    const execPath = await within(io.git(['--exec-path'], {}, left()), left(), null);
    const dir = execPath?.code === 0 ? execPath.stdout.trim() : '';
    if (!dir) return unchecked('git --exec-path failed');
    const id = await within(io.binaryId(dir, left()), left(), null);
    // Without the binary's identity the check runs every time.
    if (id === null) return await runLazyFetchProbe(io, versionStdout, safe, deadline);
    const key = [io.runner, dir, id, versionStdout.trim()].join('\0');
    let check = lazyFetchChecks.get(key);
    if (!check) {
      check = runLazyFetchProbe(io, versionStdout, safe, deadline);
      lazyFetchChecks.set(key, check);
      void check.then((r) => { if (r !== null) lazyFetchChecks.delete(key); }, () => lazyFetchChecks.delete(key));
    }
    return await check;
  } catch (err) {
    return unchecked(err instanceof Error ? err.message : String(err));
  }
}

async function runLazyFetchProbe(io: LazyFetchProbeIo, versionStdout: string, safe: readonly string[], deadline: number): Promise<string | null> {
  const ver = versionStdout.trim().slice(0, 80) || 'git';
  const unchecked = (why: string) => `${ver}: whether it honours GIT_NO_LAZY_FETCH could not be checked (${why})`;
  const left = () => deadline - Date.now();
  const dir = await within(io.makeTempDir(left()), left(), null);
  if (!dir) return unchecked('no temp folder could be made');
  try {
    // Every call: the probe repository only, read with no system or global
    // config (files that do not exist, inside the probe folder), English
    // messages, and no transport but a local path.
    const env = {
      LC_ALL: 'C',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: `${dir}/no-system-config`,
      GIT_CONFIG_GLOBAL: `${dir}/no-global-config`,
    };
    const g = (args: string[]) => within(io.git([`--git-dir=${dir}`, ...safe, ...args], env, left()), left(), null);
    const step = async (args: string[]): Promise<GitOut | string> => {
      const r = await g(args);
      if (!r) return unchecked(`git ${args[0]} did not finish in time`);
      return r.code === 0 ? r : unchecked(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 200)}`);
    };
    // The objects first, in a plain repository: a tree naming a blob that
    // is in no repository.
    const blob = crypto.randomBytes(20).toString('hex');
    for (const args of [['init', '-q', '--bare', '--template=', '--object-format=sha1'], ['update-index', '--add', '--cacheinfo', `100644,${blob},f`]]) {
      const r = await step(args);
      if (typeof r === 'string') return r;
    }
    const tree = await step(['write-tree', '--missing-ok']);
    if (typeof tree === 'string') return tree;
    const treeOid = tree.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(treeOid)) return unchecked('git write-tree printed no tree id');
    // Then a partial clone whose promisor remote does not exist.
    for (const [key, value] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'probe'], ['remote.probe.url', `${dir}/missing`], ['remote.probe.promisor', 'true']]) {
      const r = await step(['config', key, value]);
      if (typeof r === 'string') return r;
    }
    const judged = await g(['diff-tree', '-p', '--no-ext-diff', '--no-textconv', '--no-renames', EMPTY_TREE_SHA1, treeOid]);
    return lazyFetchProbeRefusal(versionStdout, judged ?? { code: -1, stderr: '', timedOut: true });
  } finally {
    await within(io.removeTempDir(dir, LAZY_FETCH_PROBE_CLEANUP_MS), LAZY_FETCH_PROBE_CLEANUP_MS, undefined);
  }
}

/** `timeout` argv (coreutils) for a call inside WSL with `ms` left. */
function wslTimeoutArgv(ms: number): string[] {
  return ['timeout', '-k', '1', String(Math.max(1, Math.ceil(ms / 1000)))];
}

const WSL_PROBE_DIR_RE = /^\/tmp\/wmux-git-probe\.[A-Za-z0-9]{8}$/;

/**
 * Main's git on the task's recorded repository, after the capability check
 * and the repository config check (workerGitPreflight): refused for a ref store
 * other than files or a partial clone. Never throws.
 */
export async function openTaskGitRepo(input: TaskGitRepoInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<{ ok: true; repo: TaskGitRepo } | { ok: false; reason: 'git-failed' | 'config-refused'; error: string }> {
  const platform = deps.platform ?? process.platform;
  const fail = (error: string) => ({ ok: false as const, reason: 'git-failed' as const, error });
  if (!TASK_ID_RE.test(input.taskId)) return fail('the task id is not a plain name');
  const target = taskGitDirTarget(input.gitCommonDir, platform);
  if (target.kind === 'refused') return fail(target.error);
  const wslExec = deps.wslExec ?? defaultWslExec;
  const safe = workerGitSafeArgs(target.kind === 'wsl' ? '/dev/null' : path.resolve(input.noHooksDir));
  // The stable cwd for host git: never discovered from, always overridden by
  // --git-dir or GIT_DIR.
  const hostCwd = os.homedir();

  // run(args, env): git on the right target, env added. Called only through
  // exec below, so every call runs with taskGitEnv.
  let run: (args: string[], env: Record<string, string>) => Promise<GitOut>;
  let common: string; // the recorded common git dir, in the serving git's spelling
  let toLinux: ((winPath: string) => Promise<string | null>) | null = null;
  if (target.kind === 'wsl') {
    common = target.gitDir;
    const wslExe = wslExePath(process.env.SystemRoot);
    run = (args, env) => wslExec(wslExe, ['-d', target.distro, '--cd', '/', '--exec', 'git', ...args], wslEnv(env));
    toLinux = deps.toWslPath
      ? async (p) => deps.toWslPath!(p)
      : async (p) => {
        const r = await wslExec(wslExe, ['-d', target.distro, '--cd', '/', '--exec', 'wslpath', '-u', '--', p], wslEnv());
        const out = r.stdout.replace(/\r?\n$/, '');
        return r.code === 0 && out.startsWith('/') ? out : null;
      };
  } else {
    if (!path.isAbsolute(input.gitCommonDir)) return fail('the task\'s recorded repository is not an absolute path');
    const real = hostRealpath(input.gitCommonDir);
    const same = real !== null && (platform === 'win32' ? real.toLowerCase() === input.gitCommonDir.toLowerCase() : real === input.gitCommonDir);
    if (!same) return fail(`the task's repository ${input.gitCommonDir} no longer resolves to itself`);
    common = input.gitCommonDir;
    run = (args, env) => git(args, hostCwd, env);
  }
  const exec = (args: string[], env: Record<string, string>) => run(args, taskGitEnv(env));

  // The capability check: every call sets GIT_NO_LAZY_FETCH, so git must
  // honour it. A version known to is taken as is; any other is checked once
  // with this same runner (gitLazyFetchRefusal).
  const ver = await exec(['--version'], {});
  if (ver.code !== 0) return fail(`git --version failed: ${ver.stderr.trim().slice(0, 300)}`);
  if (gitVersionRefusal(ver.stdout)) {
    const wslExe = wslExePath(process.env.SystemRoot);
    const inDistro = (distro: string, ms: number, argv: string[], env: Record<string, string> = {}) =>
      wslExec(wslExe, ['-d', distro, '--cd', '/', '--exec', ...wslTimeoutArgv(ms), ...argv], wslEnv(env));
    const probeIo: LazyFetchProbeIo = target.kind === 'wsl'
      ? {
        runner: `wsl:${target.distro.toLowerCase()}`,
        git: (args, env, ms) => inDistro(target.distro, ms, ['git', ...args], taskGitEnv(env)),
        binaryId: async (execPath, ms) => {
          const r = await inDistro(target.distro, ms, ['stat', '-L', '-c', '%d:%i:%s:%Y', '--', path.posix.join(execPath, 'git')]);
          const out = r.stdout.trim();
          return r.code === 0 && /^\d+:\d+:\d+:\d+$/.test(out) ? out : null;
        },
        makeTempDir: async (ms) => {
          const r = await inDistro(target.distro, ms, ['mktemp', '-d', '/tmp/wmux-git-probe.XXXXXXXX']);
          const out = r.stdout.replace(/\r?\n$/, '');
          return r.code === 0 && WSL_PROBE_DIR_RE.test(out) ? out : null;
        },
        removeTempDir: async (dir, ms) => {
          if (WSL_PROBE_DIR_RE.test(dir)) await inDistro(target.distro, ms, ['rm', '-r', '-f', '--', dir]);
        },
      }
      : {
        runner: 'host',
        git: (args, env, ms) => git(args, hostCwd, taskGitEnv(env), { timeoutMs: ms }),
        binaryId: async (execPath) => {
          try {
            const st = fs.statSync(path.join(execPath, platform === 'win32' ? 'git.exe' : 'git'));
            return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
          } catch {
            return null;
          }
        },
        makeTempDir: async () => {
          try {
            return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-probe-'));
          } catch {
            return null;
          }
        },
        removeTempDir: async (dir) => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best-effort: a folder under the OS temp folder.
          }
        },
      };
    const refusal = await gitLazyFetchRefusal(probeIo, ver.stdout, safe);
    if (refusal) return { ok: false, reason: 'config-refused', error: refusal };
  }

  const local = (args: string[]) => exec([`--git-dir=${common}`, ...safe, ...args], { GIT_COMMON_DIR: common });
  const pre = await workerGitPreflight(local);
  if (!pre.ok) return { ok: false, reason: 'config-refused', error: pre.error };
  const own = (key: string) => pre.entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && e.key === key)?.value;
  const refStorage = own('extensions.refstorage');
  if (refStorage !== undefined && refStorage.toLowerCase() !== 'files') {
    return { ok: false, reason: 'config-refused', error: 'the repository keeps its refs in a ref store main does not read' };
  }
  const promisor = pre.entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && (e.key === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(e.key)));
  if (promisor) return { ok: false, reason: 'config-refused', error: `the repository is a partial clone (${promisor.key})` };
  const objectFormat = (own('extensions.objectformat') ?? 'sha1').toLowerCase();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return { ok: false, reason: 'config-refused', error: `the repository's object format ${objectFormat} is not one main reads` };
  const idRe = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  // A shallow repository: the relay reads the boundary commits from its own
  // `shallow`, so main copies the list there. Main reads `shallow` itself
  // (readWorkerFile), before any git call that would.
  const shallowPath = target.kind === 'wsl' ? path.posix.join(common, 'shallow') : path.join(common, 'shallow');
  const shallowPresent = target.kind === 'wsl' ? await wslPathPresent(wslExec, target.distro, shallowPath) : await hostPathPresent(shallowPath);
  if (shallowPresent === null) return { ok: false, reason: 'config-refused', error: 'the repository\'s shallow list could not be read' };
  let shallowList = '';
  if (shallowPresent) {
    const text = target.kind === 'wsl'
      ? await wslReadFile(wslExec, target.distro, shallowPath, SHALLOW_MAX)
      : await readWorkerFile(shallowPath, SHALLOW_MAX);
    const ids = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (text === null || ids.length === 0 || !ids.every((id) => idRe.test(id))) return { ok: false, reason: 'config-refused', error: 'the repository\'s shallow list could not be read' };
    shallowList = `${[...new Set(ids)].join('\n')}\n`;
  }

  // The recorded worktree git dir, for HEAD (a push only).
  let worktreeGitDir: string | null = null;
  if (input.gitWorktreeDir) {
    if (target.kind === 'wsl') {
      const wt = taskGitDirTarget(input.gitWorktreeDir, platform);
      if (wt.kind === 'wsl' && wt.distro.toLowerCase() === target.distro.toLowerCase() && path.posix.dirname(path.posix.dirname(wt.gitDir)) === common) worktreeGitDir = wt.gitDir;
    } else {
      const real = hostRealpath(input.gitWorktreeDir);
      if (real && path.dirname(path.dirname(real)) === common) worktreeGitDir = real;
    }
  }
  const headOid: TaskGitRepo['headOid'] = async () => {
    if (!worktreeGitDir) return { ok: false, error: 'main recorded no worktree git dir for this task' };
    const text = target.kind === 'wsl'
      ? await wslReadFile(wslExec, target.distro, path.posix.join(worktreeGitDir, 'HEAD'))
      : await readWorkerFile(path.join(worktreeGitDir, 'HEAD'));
    if (text === null) return { ok: false, error: 'the worktree\'s HEAD is not a small plain file' };
    const parsed = parseTaskHead(text, objectFormat);
    if (!parsed) return { ok: false, error: 'the worktree\'s HEAD names neither a commit id nor a plain branch' };
    if (parsed.kind === 'oid') return { ok: true, oid: parsed.oid };
    const r = await local(['rev-parse', '--verify', '--quiet', '--end-of-options', parsed.ref]);
    const oid = r.stdout.trim();
    return r.code === 0 && idRe.test(oid) ? { ok: true, oid } : { ok: false, error: `${parsed.ref} could not be read` };
  };

  // The relay: a bare repository main owns, objects borrowed from the recorded
  // repository, origin set to the verified URL. Reused across calls.
  const relayHostPath = path.join(input.relayRoot, input.taskId);
  const context = parseRawGitConfigList(pre.stdout);
  // The owner's `includeIf "hasconfig:remote.*.url:…"` was evaluated above
  // against every remote URL the repository's config holds, in any scope
  // (the worker can respell or add one, and an include can add one). With
  // such an include, the replay below stands only when every one of those
  // URLs is exactly the one the relay uses; otherwise the relay's own
  // reading (origin = the URL main set) stands and nothing read through the
  // repository is replayed.
  const ownerHasConfigInclude = context.some((e) => (e.scope === 'system' || e.scope === 'global' || e.scope === 'unknown') && /^includeif\.hasconfig:/i.test(e.key));
  const remoteUrls = context.filter((e) => /^remote\..+\.url$/i.test(e.key)).map((e) => e.value);
  // Likewise any other owner include condition (`onbranch:`, evaluated
  // against the recorded repository's HEAD; `worktree:`, against its
  // `core.worktree`; any condition git adds later): the worker can change
  // what it is evaluated against, so with one, nothing read through the
  // repository is replayed. Only `gitdir:` (main's recorded path) and
  // exactly `hasconfig:remote.*.url:` (above) are not.
  const ownerStateInclude = context.some((e) => (e.scope === 'system' || e.scope === 'global' || e.scope === 'unknown') && /^includeif\./i.test(e.key) && !/^includeif\.(?:gitdir:|gitdir\/i:|hasconfig:remote\.\*\.url:)/i.test(e.key));
  const protocols = deps.protocols ?? RELAY_GIT_DEFAULT_PROTOCOLS;
  const relayShellPath = target.kind === 'wsl' ? (await (toLinux as (p: string) => Promise<string | null>)(relayHostPath)) ?? '' : relayHostPath;

  const inRelay: TaskGitRepo['inRelay'] = (url, fn) => withRelayLock(relayHostPath, async () => {
    try {
      if (!relayShellPath) return { ok: false as const, error: `main's relay folder ${relayHostPath} has no path inside WSL` };
      const linuxObjects = target.kind === 'wsl' ? path.posix.join(common, 'objects') : path.join(common, 'objects');
      const relayArg = `--git-dir=${relayShellPath}`;
      const relayGit = (args: string[]) => exec([relayArg, ...args], {});
      // Create once; refresh the borrowed objects, origin and shallow each time
      // (the worker can change them between calls).
      const fresh = !fs.existsSync(path.join(relayHostPath, 'HEAD'));
      if (fresh) {
        fs.mkdirSync(relayHostPath, { recursive: true, mode: 0o700 });
        const init = await relayGit([...safe, 'init', '-q', '--bare', '--template=', `--object-format=${objectFormat}`]);
        if (init.code !== 0) return { ok: false as const, error: `git init failed: ${init.stderr.trim().slice(0, 300)}` };
      }
      fs.mkdirSync(path.join(relayHostPath, 'objects', 'info'), { recursive: true });
      fs.writeFileSync(path.join(relayHostPath, 'objects', 'info', 'alternates'), `${linuxObjects}\n`);
      if (shallowList) fs.writeFileSync(path.join(relayHostPath, 'shallow'), shallowList);
      else fs.rmSync(path.join(relayHostPath, 'shallow'), { force: true });
      const setUrl = await relayGit([...safe, 'config', 'remote.origin.url', url]);
      if (setUrl.code !== 0) return { ok: false as const, error: `git config failed: ${setUrl.stderr.trim().slice(0, 300)}` };
      // The owner's transport config for the recorded repository, reset and
      // replayed so the relay matches it.
      const relayList = await relayGit([...safe, 'config', '-z', '--list', '--show-scope']);
      if (relayList.code !== 0) return { ok: false as const, error: `git config --list failed: ${relayList.stderr.trim().slice(0, 300)}` };
      const replayable = !ownerStateInclude && (!ownerHasConfigInclude || remoteUrls.every((u) => u === url));
      const replay = !replayable ? [] : transportConfigReplay(context, parseRawGitConfigList(relayList.stdout)).flatMap((kv) => ['-c', kv]);
      const relayArgs = relayGitConfigArgs(safe, protocols);
      const run = (args: string[]) => relayGit([...relayArgs, ...replay, ...args]);
      return { ok: true as const, value: await fn(run) };
    } catch (err) {
      return { ok: false as const, error: `main's relay git dir failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  const workerShellPlatform: NodeJS.Platform = target.kind === 'wsl' ? 'linux' : platform;
  return { ok: true, repo: { entries: pre.entries, local, headOid, inRelay, relayShellPath, workerShellPlatform, inWslDistro: target.kind === 'wsl' } };
}

/** Removes the relay of a task that has closed, after any call on it ends. */
export function removeTaskRelay(relayRoot: string, taskId: string): Promise<void> {
  if (!TASK_ID_RE.test(taskId)) return Promise.resolve();
  const dir = path.join(relayRoot, taskId);
  return withRelayLock(dir, async () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Swept at the next start (sweepTaskGitRelays).
    }
  });
}

/** Removes relays whose task is no longer open (main's start, and when a task
 *  closes). */
export function sweepTaskGitRelays(relayRoot: string, isOpen: (taskId: string) => boolean): void {
  let names: string[];
  try {
    names = fs.readdirSync(relayRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (isOpen(name)) continue;
    try {
      fs.rmSync(path.join(relayRoot, name), { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

/** Push the task branch. Never throws. `git` is main's own git (a task in a
 *  WSL distro uses that distro's, see taskGitDirTarget). */
export async function pushTaskBranch(input: TaskPushInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<TaskPushResult> {
  const branchRefusal = taskPushBranchRefusal(input.branch, input.defaultBranches);
  if (branchRefusal) return { ok: false, reason: 'branch-refused', error: branchRefusal };
  const opened = await openTaskGitRepo(input, git, deps);
  if (!opened.ok) return opened;
  const { repo } = opened;
  const origin = workerOriginRefusal(repo.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  const pinned = await originPinUrl(origin.url, input);
  if ('error' in pinned) return { ok: false, reason: 'remote-refused', error: pinned.error };
  // The URL every network call below uses.
  const url = pinned.url;
  for (const u of new Set([origin.url, url])) {
    const named = urlNamedRemoteRefusal(repo.entries, u);
    if (named) return { ok: false, reason: 'config-refused', error: named };
  }
  // The repository's own default branch, under every name it is read by.
  const own: string[] = [];
  const byKey = key && input.repoDefaultBranch ? await input.repoDefaultBranch(key).catch(() => null) : null;
  if (byKey) own.push(byKey);
  const ref = await repo.local(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const name = ref.code === 0 ? ref.stdout.trim() : '';
  if (name.startsWith('refs/remotes/origin/')) own.push(name.slice('refs/remotes/origin/'.length));
  const remote = await repo.inRelay(url, (run) => run(['ls-remote', '--symref', '--', url, 'HEAD']));
  const remoteHead = remote.ok && remote.value.code === 0 ? parseLsRemoteHead(remote.value.stdout) : null;
  if (remoteHead) own.push(remoteHead);
  if (own.length > 0) {
    const refusal = taskPushBranchRefusal(input.branch, [...input.defaultBranches, ...own]);
    if (refusal) return { ok: false, reason: 'branch-refused', error: refusal };
  }
  // HEAD is resolved once, through the recorded worktree git dir, to a
  // commit id; git is handed that id, never the HEAD text.
  const head = await repo.headOid();
  if (!head.ok) return { ok: false, reason: 'git-failed', error: head.error };
  const commit = await repo.local(['rev-parse', '--verify', '--quiet', '--end-of-options', `${head.oid}^{commit}`]);
  const sha = commit.stdout.trim();
  if (commit.code !== 0 || sha !== head.oid) {
    return { ok: false, reason: 'git-failed', error: `the worktree's HEAD ${head.oid} is not a commit in the task's repository` };
  }
  const pushed = await repo.inRelay(url, (run) => run(taskPushArgs(input.branch, url, sha)));
  if (!pushed.ok) return { ok: false, reason: 'git-failed', error: pushed.error };
  const res = pushed.value;
  const output = `${res.stdout}\n${res.stderr}`.trim().slice(0, 2000);
  if (res.code !== 0) {
    const rejected = /^!\t/m.test(res.stdout);
    return { ok: false, reason: rejected ? 'rejected' : 'git-failed', error: output || `git push exited ${res.code}` };
  }
  return { ok: true, branch: input.branch, remote: 'origin', head: sha, output };
}
