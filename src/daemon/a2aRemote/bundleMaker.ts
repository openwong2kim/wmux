import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getExecEnv } from '../../shared/execEnv';
import { resolveExecutable } from '../../shared/exeSearch';
import { BUNDLE_REF_PREFIX, bundleRefName, type A2aBundleRefusal } from '../../shared/a2aBundle';
import { parseGitConfigList, workerGitConfigRefusal } from '../../main/worktask/workerGit';
import { filterDriverNames, type Git } from '../../main/a2aRemote/spawnWorktree';
import { buildGitEnv, filterOverrideArgs } from '../web/sessionDiff';
import { GIT_NULL_DEVICE } from '../web/phoneGitPush';
import { rootOriginKey } from './continueRootGit';
import { errMsg } from './storeFile';

/**
 * The box makes a git bundle of what an agent it started for another PC
 * committed: the spawn's branch past the commit its worktree started from,
 * and nothing else of the repository.
 *
 * The bundle holds one ref, `refs/wmux/bundle/<tree id>` (a2aBundle.ts
 * bundleRefName), pinned to the branch's head as read before the make. That
 * ref is made only for the make, where no ref of that name is (git refuses
 * it otherwise), and removed after it whatever the outcome; one a crash left
 * behind is swept at start (sweepBundleRefs).
 *
 * Every git here runs with no global or system config, no GIT_* variable of
 * the daemon's own, no fsmonitor and no hooks, under a time limit past which
 * it is killed. Before any of it the repository's own config is read, and a
 * key that makes git run a program (workerGit.ts PROGRAM_KEYS) refuses the
 * make. Nothing is committed on the box: work the agent did not commit is not
 * in the bundle (`uncommitted-only` when that is all there is).
 */

/** A commit id: SHA-1, or SHA-256 for a repository that uses it. */
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The branch a headless start made: `wmux/remote/<tree id>` (spawnWorktree.ts branchFor). */
const BRANCH_RE = /^wmux\/remote\/sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TREE_ID_RE = /^sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What one read may print (a config list, a status). */
const READ_OUTPUT_MAX = 16 * 1024 * 1024;

export const BUNDLE_GIT_READ_TIMEOUT_MS = 60_000;
export const BUNDLE_GIT_CREATE_TIMEOUT_MS = 10 * 60_000;

export interface BundleMakeInput {
  /** The start's worktree (the record's, never a path the asking PC sent). */
  worktree: string;
  /** The start's branch and the commit its worktree started from (the record's). */
  branch: string;
  base: string;
  /** The tree id the start was named with: the bundle's ref is named after it. */
  treeId: string;
  /** The repository the asking PC names, as originUrlRepoKey writes it. */
  origin: string;
  /** Where the bundle goes: a path the box chose, made here with O_EXCL. */
  file: string;
  /** The most bytes it may take. */
  maxBytes: number;
}

export type BundleMakeOutcome =
  | { kind: 'made'; head: string; sha256: string; bytes: number }
  | { kind: 'refused'; reason: A2aBundleRefusal; detail?: string };

export interface BundleGitOptions {
  /** Each read's time limit. */
  readTimeoutMs?: number;
  /** The bundle's own time limit. */
  createTimeoutMs?: number;
  /** Test seam: the env git runs with before it is cleaned (default: the daemon's exec env). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: called with a way to kill the bundle's git once it runs, and its pid (its process group's id). */
  onCreate?: (kill: () => void, pid: number | undefined) => void;
}

/** git with this module's isolation, in `at`. Never throws. */
export function bundleGit(at: string, opts: BundleGitOptions = {}): Git {
  const env = isolatedEnv(opts.env ?? getExecEnv());
  const gitExe = resolveExecutable('git', { env });
  const timeoutMs = opts.readTimeoutMs ?? BUNDLE_GIT_READ_TIMEOUT_MS;
  return (args, pre = [], dir = at) => runGit(gitExe, [...SAFE_ARGS, ...pre, '-C', dir, ...args], dir, env, timeoutMs);
}

const SAFE_ARGS: readonly string[] = [
  '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${GIT_NULL_DEVICE}`,
  // Local only: nothing here fetches, and a partial clone does not reach out for a missing object.
  '-c', 'protocol.allow=never',
];

/**
 * Only what git needs to run (buildGitEnv's allowlist: no GIT_* of the
 * daemon's own), with no global or system config.
 */
function isolatedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...buildGitEnv(base), GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1' };
}

function runGit(gitExe: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(gitExe, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: errMsg(err) });
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let size = 0;
    let killed: string | null = null;
    const kill = (why: string): void => {
      if (killed) return;
      killed = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timed out'), timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > READ_OUTPUT_MAX) kill('printed too much');
      else out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => { if (errOut.reduce((n, x) => n + x.length, 0) < 64 * 1024) errOut.push(b); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: errMsg(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? 1 : code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: killed ?? Buffer.concat(errOut).toString('utf8'),
      });
    });
  });
}

/**
 * The repository's own config names no program git would run here: null, or
 * why not; with the `-c` overrides that disarm every content filter it names.
 */
async function configRefusal(git: Git): Promise<{ refusal: string | null; disarm: string[] }> {
  const list = await git(['config', '-z', '--list', '--show-scope']);
  if (list.code !== 0) throw new Error(`git config --list failed: ${list.stderr.trim().slice(0, 300)}`);
  return { refusal: workerGitConfigRefusal(parseGitConfigList(list.stdout), 'all'), disarm: filterOverrideArgs(filterDriverNames(list.stdout)) };
}

/** The zero id of the repository's hash: as an expected old value, "no such ref". */
const zeroOf = (sha: string): string => '0'.repeat(sha.length);

/**
 * Make the bundle. Every refusal leaves no file at `input.file` and no ref of
 * the make's; a git that failed or ran past its time is `unavailable`.
 */
export async function makeBundle(input: BundleMakeInput, opts: BundleGitOptions = {}): Promise<BundleMakeOutcome> {
  if (!BRANCH_RE.test(input.branch) || !COMMIT_RE.test(input.base) || !TREE_ID_RE.test(input.treeId)) {
    return { kind: 'refused', reason: 'base-missing', detail: 'the start record does not name a branch and base this takes' };
  }
  const git = bundleGit(input.worktree, opts);
  try {
    const first = await configRefusal(git);
    if (first.refusal) return { kind: 'refused', reason: 'repo-config', detail: first.refusal };
    const key = await rootOriginKey(git, input.worktree);
    if (key === null || key !== input.origin) return { kind: 'refused', reason: 'origin-mismatch' };
    const shallow = await git(['rev-parse', '--is-shallow-repository']);
    if (shallow.code !== 0) return unavailable('rev-parse --is-shallow-repository', shallow.stderr);
    if (shallow.stdout.trim() === 'true') return { kind: 'refused', reason: 'shallow' };

    const tip = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${input.branch}^{commit}`]);
    const head = tip.stdout.trim();
    if (tip.code !== 0 || !COMMIT_RE.test(head)) return { kind: 'refused', reason: 'base-missing', detail: 'the branch is gone' };
    const baseThere = await git(['cat-file', '-e', `${input.base}^{commit}`]);
    if (baseThere.code !== 0) return { kind: 'refused', reason: 'base-missing', detail: 'the base commit is not in the repository' };
    const under = await git(['merge-base', '--is-ancestor', input.base, head]);
    if (under.code === 1) return { kind: 'refused', reason: 'base-missing', detail: 'the base is not under the branch' };
    if (under.code !== 0) return unavailable('merge-base --is-ancestor', under.stderr);
    if (head === input.base) {
      // A status reads file content, which a filter could run a program on: the config is read again just
      // before it (the agent may have changed it since), and every filter it names is disarmed for the read.
      const now = await configRefusal(git);
      if (now.refusal) return { kind: 'refused', reason: 'repo-config', detail: now.refusal };
      // Submodules are not read: their own config could name a filter.
      const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], now.disarm);
      if (status.code !== 0) return unavailable('status', status.stderr);
      return { kind: 'refused', reason: status.stdout.length > 0 ? 'uncommitted-only' : 'empty' };
    }

    // Known too large before any byte is written (an estimate: the bundle's own size is checked as it is written).
    const usage = await git(['rev-list', '--objects', '--disk-usage', head, `^${input.base}`]);
    const estimate = usage.code === 0 ? Number(usage.stdout.trim()) : NaN;
    if (Number.isFinite(estimate) && estimate > input.maxBytes) return { kind: 'refused', reason: 'too-large', detail: `about ${estimate} bytes` };

    return await withRef(git, bundleRefName(input.treeId), head, () => writeBundle(input, head, opts));
  } catch (err) {
    await fs.promises.rm(input.file, { force: true }).catch(() => undefined);
    return { kind: 'refused', reason: 'unavailable', detail: errMsg(err) };
  }
}

function unavailable(what: string, stderr: string): BundleMakeOutcome {
  return { kind: 'refused', reason: 'unavailable', detail: `git ${what} failed: ${stderr.trim().slice(0, 300)}` };
}

/**
 * Run `fn` while `ref` points at `sha`: made only where no such ref is, removed after whatever happens. A ref of
 * that name a stopped make left (one make per PC at a time, and the name is this start's own) is removed first.
 */
async function withRef(git: Git, ref: string, sha: string, fn: () => Promise<BundleMakeOutcome>): Promise<BundleMakeOutcome> {
  await git(['update-ref', '--no-deref', '-d', ref]);
  const made = await git(['update-ref', '--no-deref', ref, sha, zeroOf(sha)]);
  if (made.code !== 0) return unavailable('update-ref', made.stderr);
  try {
    return await fn();
  } finally {
    const gone = await git(['update-ref', '--no-deref', '-d', ref, sha]);
    if (gone.code !== 0) await git(['update-ref', '--no-deref', '-d', ref]);
  }
}

/**
 * `git bundle create` of the ref past the base, written to a new file as it
 * comes (O_EXCL, 0600), counted and hashed on the way: past `maxBytes` the
 * git is killed and the file goes. Then the bundle must name exactly that ref
 * at `head`.
 *
 * git hands the pack to a `pack-objects` child that writes to the same pipe,
 * so git runs in a process group of its own and a stop kills the whole group
 * and closes the pipe: nothing is left writing or blocked on it. A stop (the
 * time limit, a failed write, the size cap) settles the make at once, without
 * waiting for the pipe to close. Headless boxes are Linux and macOS; on
 * Windows only the git process itself is killed.
 */
async function writeBundle(input: BundleMakeInput, head: string, opts: BundleGitOptions): Promise<BundleMakeOutcome> {
  const ref = bundleRefName(input.treeId);
  const env = isolatedEnv(opts.env ?? getExecEnv());
  const gitExe = resolveExecutable('git', { env });
  const handle = await fs.promises.open(input.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  let outcome: BundleMakeOutcome;
  try {
    outcome = await new Promise<BundleMakeOutcome>((resolve) => {
      const child = spawn(gitExe, [...SAFE_ARGS, '-C', input.worktree, 'bundle', 'create', '-q', '-', ref, `^${input.base}`], {
        cwd: input.worktree, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      let stopped = false;
      let settled = false;
      let writing: Promise<unknown> = Promise.resolve();
      let errText = '';
      const settle = (o: BundleMakeOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The write under way (if any) ends before the file is closed; a failed one has stopped the make already.
        void writing.then(() => resolve(o), () => resolve(o));
      };
      const stop = (why: BundleMakeOutcome): void => {
        if (stopped) return;
        stopped = true;
        killGroup(child);
        child.stdout.destroy();
        child.stderr.destroy();
        settle(why);
      };
      const timer = setTimeout(() => stop({ kind: 'refused', reason: 'unavailable', detail: 'git bundle create ran past its time' }), opts.createTimeoutMs ?? BUNDLE_GIT_CREATE_TIMEOUT_MS);
      opts.onCreate?.(() => stop({ kind: 'refused', reason: 'unavailable', detail: 'git bundle create was killed' }), child.pid);
      child.stdout.on('data', (b: Buffer) => {
        if (stopped) return;
        bytes += b.length;
        if (bytes > input.maxBytes) {
          stop({ kind: 'refused', reason: 'too-large', detail: `past ${input.maxBytes} bytes` });
          return;
        }
        hash.update(b);
        // One write at a time: git waits while the disk catches up, and a failed write (a full disk) stops it.
        child.stdout.pause();
        writing = writing.then(() => writeAll(handle, b)).then(
          () => { if (!stopped) child.stdout.resume(); },
          (err: unknown) => stop({ kind: 'refused', reason: 'unavailable', detail: `the bundle could not be written: ${errMsg(err)}` }),
        );
      });
      child.stdout.on('error', () => undefined);
      child.stderr.on('error', () => undefined);
      child.stderr.on('data', (b: Buffer) => { if (errText.length < 4096) errText += b.toString('utf8'); });
      child.on('error', (err) => stop({ kind: 'refused', reason: 'unavailable', detail: errMsg(err) }));
      child.on('close', (code) => {
        if (stopped) return;
        settle(code === 0
          ? { kind: 'made', head, sha256: hash.digest('hex'), bytes }
          : { kind: 'refused', reason: 'unavailable', detail: `git bundle create failed: ${errText.trim().slice(0, 300)}` });
      });
    });
    if (outcome.kind === 'made') {
      await handle.sync();
      const heads = await bundleGit(input.worktree, opts)(['bundle', 'list-heads', input.file]);
      if (heads.code !== 0) outcome = unavailable('bundle list-heads', heads.stderr);
      else if (heads.stdout.trim() !== `${head} ${ref}`) outcome = { kind: 'refused', reason: 'changed' };
    }
  } finally {
    await handle.close();
  }
  if (outcome.kind !== 'made') await fs.promises.rm(input.file, { force: true });
  return outcome;
}

/** Kill git and every process of its group (its pack-objects); only git itself where there are no groups. */
function killGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Write all of `b`: a write may take part of it. */
async function writeAll(handle: fs.promises.FileHandle, b: Buffer): Promise<void> {
  let at = 0;
  while (at < b.length) {
    // eslint-disable-next-line no-await-in-loop -- in order
    const { bytesWritten } = await handle.write(b, at, b.length - at);
    if (bytesWritten <= 0) throw new Error('the disk took no bytes');
    at += bytesWritten;
  }
}

/** Remove every ref a make left in the repository at `worktree` (a crash between its making and its removal). */
export async function sweepBundleRefs(worktree: string, opts: BundleGitOptions = {}): Promise<number> {
  const git = bundleGit(worktree, opts);
  const list = await git(['for-each-ref', '--format=%(refname)', BUNDLE_REF_PREFIX]);
  if (list.code !== 0) return 0;
  let removed = 0;
  for (const ref of list.stdout.split('\n').map((l) => l.trim())) {
    if (!ref.startsWith(BUNDLE_REF_PREFIX) || !TREE_ID_RE.test(ref.slice(BUNDLE_REF_PREFIX.length))) continue;
    // eslint-disable-next-line no-await-in-loop -- one ref at a time
    const gone = await git(['update-ref', '--no-deref', '-d', ref]);
    if (gone.code === 0) removed += 1;
  }
  return removed;
}
