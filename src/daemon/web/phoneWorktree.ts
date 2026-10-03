import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  buildGitEnv, createGitRunner, gitArgv, resolveFilterOverrides, GIT_MAX_BUFFER_BYTES,
  type GitRunner, type GitRunResult,
} from './sessionDiff';
import { canonicalPath, listWorktrees, resolvePhoneGitRepo, type PhoneGitRepo, type WorktreeRow } from './phoneGitRead';
import { PhoneWorktreeReceipts, ReceiptCapacityError, type PhoneWorktreeExec, type PhoneWorktreeOutcome } from './phoneWorktreeReceipts';
import {
  parseWorktreeCreateBody, phoneWorktreeAddArgs, phoneWorktreeNames, PHONE_WORKTREE_DIR_PREFIX, PHONE_WORKTREE_RETRY_AFTER_MS,
  type PhoneWorktreeReceipt, type PhoneWorktreeRefusal,
} from '../../shared/phoneGitV1';
import { directoryHold, type DirectoryHold } from '../../shared/directoryHold';
import { killProcessTree } from '../automation/treeKill';

/**
 * Phone worktree creation (contract item 5, `POST …/git/worktree`).
 *
 * The phone sends a slug and a request id, nothing else. The branch
 * (`phone/<slug>`), the directory (`${wmuxHome}/worktrees/<projectId>/phone-<slug>`)
 * and the base (the session's HEAD, resolved once to an oid before any write)
 * are all derived here. The job runs outside the HTTP request, serialized per
 * repository (realpath of the git common dir), and its outcome lands in the
 * durable receipt store.
 */

/**
 * `git worktree add` checks out a whole tree, which on a large repository can
 * take far longer than the 5 s per-command bound the preflight reads use.
 * Killing it at 5 s would manufacture the half-written state the receipts
 * exist to describe, so the add alone gets this bound.
 */
export const PHONE_WORKTREE_ADD_TIMEOUT_MS = 120_000;
/** Bound on the whole-tree attribute and path-length scan. */
export const PHONE_WORKTREE_SCAN_TIMEOUT_MS = 30_000;
/** Longest path the daemon will create on Windows (MAX_PATH), and longest worktree directory anywhere. */
export const PHONE_WORKTREE_MAX_PATH = 260;
/**
 * Longest directory Git for Windows creates without `core.longpaths`: its
 * `mkdir` takes paths shorter than 248 characters (MAX_PATH minus room for an
 * 8.3 file name), so the worktree directory and every directory of the tree
 * inside it must fit 247.
 */
export const PHONE_WORKTREE_MAX_DIR_WINDOWS = 247;
/** How long the add's process group gets to stop after SIGTERM before it is killed. */
const KILL_GRACE_MS = 2_000;
/** Worktree creations running at once (their own budget, not the shared read slots). */
export const PHONE_WORKTREE_MAX_JOBS = 2;
/** `check-attr --source` needs git 2.40. */
const MIN_GIT: readonly [number, number] = [2, 40];
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
/** Under `wmuxDir`: an empty hooks directory and an empty attributes file. */
const EMPTY_DIR = '.phone-git-empty';

class Refusal extends Error {
  constructor(readonly tag: PhoneWorktreeRefusal) { super(tag); }
}
/** A step that did not run to an answer (killed, timed out, could not start): it concludes nothing. */
class NotRun extends Refusal {
  constructor() { super('git-operation-failed'); }
}
/** Nothing was changed; the same request may get further later. */
const RETRY: PhoneWorktreeOutcome = { state: 'unknown', error: 'git-outcome-unknown', retryAfterMs: PHONE_WORKTREE_RETRY_AFTER_MS };

/** What the whole-tree scan found: whether any path's `filter` attribute is set, the longest path and the longest directory. */
export interface TreeScan { filters: 'used' | 'unused' | 'failed'; longest: number; longestDir: number }
export type TreeScanner = (cwd: string, oid: string, config: readonly string[]) => Promise<TreeScan>;

/**
 * `git ls-tree -r --full-tree` piped into `git check-attr --source=<oid>
 * --stdin filter` (git 2.40+), over the WHOLE tree of the commit, from the
 * worktree root. Stops at the first path whose filter is set. Streams, so a
 * large tree is never buffered whole; also measures the longest path and the
 * longest directory (a path's part before its last `/`).
 */
export const scanTree: TreeScanner = (cwd, oid, config) => new Promise((resolve) => {
  const env = buildGitEnv();
  const argv = (...args: string[]) => gitArgv(...config, ...args);
  const list = spawn('git', argv('ls-tree', '-r', '-z', '--full-tree', '--name-only', oid), { cwd, env, windowsHide: true });
  const check = spawn('git', argv('check-attr', `--source=${oid}`, '-z', '--stdin', 'filter'), { cwd, env, windowsHide: true });
  let settled = false;
  let longest = 0;
  let longestDir = 0;
  let listRest = '';
  const finish = (filters: TreeScan['filters']) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    list.kill(); check.kill();
    resolve({ filters, longest, longestDir });
  };
  const timer = setTimeout(() => finish('failed'), PHONE_WORKTREE_SCAN_TIMEOUT_MS);
  list.stdout.setEncoding('utf8');
  list.stdout.on('data', (chunk: string) => {
    const names = (listRest + chunk).split('\0');
    listRest = names.pop() ?? '';
    for (const name of names) {
      longest = Math.max(longest, name.length);
      longestDir = Math.max(longestDir, name.lastIndexOf('/'));
    }
    // The listing waits while check-attr has not taken what it was given.
    if (!check.stdin.destroyed && !check.stdin.write(names.map((n) => `${n}\0`).join(''))) {
      list.stdout.pause();
      check.stdin.once('drain', () => list.stdout.resume());
    }
  });
  list.stdout.on('end', () => { if (!check.stdin.destroyed) check.stdin.end(); });
  check.stdin.on('error', () => finish('failed'));
  let rest = '';
  let field = 0;
  check.stdout.setEncoding('utf8');
  check.stdout.on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\0');
    rest = parts.pop() ?? '';
    // Records are `<path> NUL filter NUL <value> NUL`.
    for (const part of parts) {
      if (field % 3 === 2 && part !== 'unspecified' && part !== 'unset') return finish('used');
      field += 1;
    }
  });
  list.on('error', () => finish('failed'));
  check.on('error', () => finish('failed'));
  list.on('close', (code) => { if (code !== 0) finish('failed'); });
  check.on('close', (code) => finish(code === 0 ? 'unused' : 'failed'));
});

/** Stop `child` and every process it started. */
function stopTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // taskkill /T /F ends the whole tree at once; there is no second step.
    if (signal === 'SIGTERM') void killProcessTree(child.pid);
    return;
  }
  // The child leads its own process group: SIGTERM lets each git in it
  // release its lock files, SIGKILL ends whatever is left.
  try { process.kill(-child.pid, signal); } catch { /* the group is gone */ }
}

/**
 * The long-bounded runner for `worktree add` (and recovery's whole-checkout
 * commands). `git worktree add` runs the checkout as a child process
 * (`git reset --hard`), so on the bound the whole tree is stopped, not only
 * the command this runner started: on POSIX the command runs as the leader of
 * its own process group, which gets SIGTERM and, after a grace period,
 * SIGKILL; on Windows the tree is ended with `taskkill /T /F`. The answer
 * comes once every process holding the output pipes is gone.
 */
export function createAddRunner(timeoutMs = PHONE_WORKTREE_ADD_TIMEOUT_MS): GitRunner {
  const env = buildGitEnv();
  return (args, cwd) => new Promise<GitRunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('git', [...args], { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ ok: false, ran: false, stdout: '', stderr: '' });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let stopped = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopTree(child, 'SIGTERM');
      grace = setTimeout(() => stopTree(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(stop, timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_MAX_BUFFER_BYTES) stop();
      else into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve(result);
    };
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
    child.on('error', () => { stop(); finish({ ok: false, ran: false, stdout: text(out), stderr: text(err) }); });
    child.on('close', (code) => {
      const ran = !stopped && typeof code === 'number';
      finish({ ok: ran && code === 0, ran, code: ran ? code ?? undefined : undefined, stdout: text(out), stderr: text(err) });
    });
  });
}

export interface PhoneWorktreeJob {
  /** `device:<id>` or `operator`: the receipt namespace. */
  owner: string;
  /** For the audit line; empty for the operator token. */
  deviceId: string;
  sessionId: string;
  /** The session's trusted `spawnCwd`. */
  cwd: string;
  body: unknown;
}

export interface PhoneWorktreeOptions {
  wmuxDir: string;
  git?: GitRunner;
  addGit?: GitRunner;
  scan?: TreeScanner;
  /** Defaults to `process.platform`; Windows also bounds the longest path in the tree. */
  platform?: NodeJS.Platform;
  /** Whether a half-made worktree is still held (written) by a process. Defaults to the shared Windows probe. */
  directoryHold?: (dir: string) => Promise<DirectoryHold>;
  /** The working directories (current and spawn) of every live session: recovery never removes a checkout one runs in. */
  liveCwds?: () => string[] | Promise<string[]>;
  /** One audit line per job that reached the background: device id and outcome tag. */
  audit?: (deviceId: string, reason: string) => void;
  log?: (level: 'warn', msg: string) => void;
  now?: () => number;
}

type Submitted = { status: number; body: object; done?: Promise<void> };

export class PhoneWorktreeService {
  readonly receipts: PhoneWorktreeReceipts;
  private readonly git: GitRunner;
  private readonly addGit: GitRunner;
  private readonly scan: TreeScanner;
  /** Recovery's commands over a whole checkout (status, remove), bounded like the add. */
  private readonly longGit: GitRunner;
  private readonly platform: NodeJS.Platform;
  private readonly directoryHold: (dir: string) => Promise<DirectoryHold>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Set<string>();
  private gitVersionOk?: Promise<boolean>;

  constructor(private readonly opts: PhoneWorktreeOptions) {
    this.receipts = new PhoneWorktreeReceipts(opts.wmuxDir, opts.now);
    if (!this.receipts.available) {
      opts.log?.('warn', `[web] phone worktree receipts could not be read (${this.receipts.loadError}); phone worktree creation is off`);
    }
    this.git = opts.git ?? createGitRunner();
    this.addGit = opts.addGit ?? createAddRunner();
    this.scan = opts.scan ?? scanTree;
    this.longGit = opts.git ?? createAddRunner();
    this.platform = opts.platform ?? process.platform;
    this.directoryHold = opts.directoryHold ?? directoryHold;
  }

  get available(): boolean { return this.receipts.available; }

  /** `GET …/git/worktree/<requestId>`. */
  receipt(owner: string, sessionId: string, rawRequestId: string): PhoneWorktreeReceipt {
    const requestId = rawRequestId.toLowerCase();
    const found = this.receipts.find(owner, requestId);
    return found && found.sessionId === sessionId ? found.receipt : { requestId, state: 'none' };
  }

  /**
   * `POST …/git/worktree`: validate, replay, recover or start the job.
   * `done` resolves when a started job has settled (tests and shutdown).
   */
  submit(job: PhoneWorktreeJob): Submitted {
    if (!this.available) return { status: 503, body: { error: 'git-receipts-unavailable' } };
    const parsed = parseWorktreeCreateBody(job.body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const { slug, requestId } = parsed.value;
    const previous = this.receipts.find(job.owner, requestId);
    if (previous && (previous.sessionId !== job.sessionId || previous.slug !== slug)) {
      return { status: 409, body: { error: 'request-id-conflict' } };
    }
    // A repeat of an `unknown` receipt is a recovery run; anything else replays.
    if (previous && previous.receipt.state !== 'unknown') return { status: 200, body: { ...previous.receipt, replayed: true } };
    // One creation per caller at a time, and at most PHONE_WORKTREE_MAX_JOBS overall.
    if (this.running.has(job.owner) || this.running.size >= PHONE_WORKTREE_MAX_JOBS) {
      return { status: 429, body: { error: 'git-busy' } };
    }
    if (previous) this.receipts.reopen(job.owner, requestId);
    else {
      try {
        this.receipts.begin(job.owner, requestId, job.sessionId, slug);
      } catch (error) {
        return error instanceof ReceiptCapacityError
          ? { status: 429, body: { error: 'git-busy' } }
          : { status: 503, body: { error: 'git-receipts-unavailable' } };
      }
    }
    this.running.add(job.owner);
    const done = this.run(job, slug, requestId, previous !== null).finally(() => this.running.delete(job.owner));
    return { status: 202, body: { requestId, replayed: false, state: 'pending' }, done };
  }

  private async run(job: PhoneWorktreeJob, slug: string, requestId: string, recovering: boolean): Promise<void> {
    let outcome: PhoneWorktreeOutcome;
    try {
      outcome = await this.create(job, slug, requestId, recovering);
    } catch (error) {
      // Only a concluded refusal is final. A step that did not run to an
      // answer leaves the request retryable, whatever is left on disk.
      outcome = error instanceof NotRun ? RETRY
        : error instanceof Refusal ? { state: 'refused', error: error.tag }
        : recovering ? RETRY : { state: 'unknown', error: 'git-outcome-unknown' };
    }
    try {
      this.receipts.settle(job.owner, requestId, outcome);
      this.opts.audit?.(job.deviceId, outcome.state === 'created' ? 'created' : outcome.error);
    } catch { /* the receipt stays in memory; an audit line is best-effort */ }
  }

  private async create(job: PhoneWorktreeJob, slug: string, requestId: string, recovering: boolean): Promise<PhoneWorktreeOutcome> {
    let repo: PhoneGitRepo | null;
    try { repo = await resolvePhoneGitRepo(job.cwd, this.git); } catch { throw new NotRun(); }
    if (!repo) throw new Refusal('not-a-git-repo');
    const found = repo;
    // One job at a time per repository: two worktrees of one repository share
    // its refs and its worktree registry.
    const previous = this.queues.get(found.commonReal) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.createLocked(job, slug, requestId, found, recovering));
    const tail = work.catch(() => undefined);
    this.queues.set(found.commonReal, tail);
    void tail.then(() => { if (this.queues.get(found.commonReal) === tail) this.queues.delete(found.commonReal); });
    return work;
  }

  private async read(cwd: string, config: readonly string[], ...args: string[]): Promise<GitRunResult> {
    return this.readWith(this.git, cwd, config, ...args);
  }

  private async readWith(git: GitRunner, cwd: string, config: readonly string[], ...args: string[]): Promise<GitRunResult> {
    const result = await git(gitArgv(...config, ...args), cwd);
    if (!result.ok && result.ran === false) throw new NotRun();
    return result;
  }

  private async gitIsRecentEnough(): Promise<boolean> {
    this.gitVersionOk ??= this.git(['version'], os.tmpdir()).then((r) => {
      const m = /(\d+)\.(\d+)/.exec(r.stdout);
      if (!r.ok || !m) return false;
      const [major, minor] = [Number(m[1]), Number(m[2])];
      return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
    }).catch(() => false);
    const ok = await this.gitVersionOk;
    if (!ok) this.gitVersionOk = undefined;
    return ok;
  }

  /**
   * An empty hooks directory and an empty attributes file owned by the
   * daemon: `core.hooksPath` and `core.attributesFile` point at them, so no
   * repository hook runs and no attributes outside the tree apply. A real
   * directory rather than `/dev/null`, which is not a path on every platform.
   */
  private async jobConfig(): Promise<string[]> {
    const dir = path.join(this.opts.wmuxDir, EMPTY_DIR);
    const hooks = path.join(dir, 'hooks');
    const attributes = path.join(dir, 'attributes');
    try {
      await fs.promises.mkdir(hooks, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(attributes, '', { flag: 'a', mode: 0o600 });
      const [d, h, a] = await Promise.all([dir, hooks, attributes].map((p) => fs.promises.lstat(p)));
      if (d.isSymbolicLink() || !d.isDirectory() || h.isSymbolicLink() || !h.isDirectory() ||
          a.isSymbolicLink() || !a.isFile() || a.size !== 0 || (await fs.promises.readdir(hooks)).length !== 0) {
        throw new Error('not empty');
      }
    } catch { throw new NotRun(); }
    return ['-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgSign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      '-c', 'core.attributesFile=' + attributes];
  }

  /**
   * The parent directories of a phone worktree, walked from the trusted root
   * (`wmuxDir`, by its realpath): each existing component must be a real
   * directory, never a symbolic link or junction. With `create`, missing ones
   * are made one level at a time (a single `mkdir` never follows a link) and
   * returned so a failed job can remove them again.
   */
  private async parentOf(projectId: string, create: boolean): Promise<{ parent: string; made: string[] }> {
    let current: string;
    try { current = await fs.promises.realpath(this.opts.wmuxDir); } catch { throw new Refusal('git-operation-failed'); }
    const made: string[] = [];
    for (const part of ['worktrees', projectId]) {
      current = path.join(current, part);
      const stat = await fs.promises.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw new Refusal('git-operation-failed');
      });
      if (stat === null) {
        if (!create) return { parent: path.join(current, ...(part === 'worktrees' ? [projectId] : [])), made };
        try { await fs.promises.mkdir(current, { mode: 0o700 }); } catch { throw new Refusal('worktree-path-unsafe'); }
        made.push(current);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Refusal('worktree-path-unsafe');
    }
    // Belt and braces: the resolved parent is exactly the path walked.
    if (await fs.promises.realpath(current).catch(() => '') !== current) throw new Refusal('worktree-path-unsafe');
    return { parent: current, made };
  }

  private async removeEmpty(dirs: string[]): Promise<void> {
    for (const dir of [...dirs].reverse()) await fs.promises.rmdir(dir).catch(() => undefined);
  }

  /** Every refusal is decided here, before anything is written. */
  private async createLocked(job: PhoneWorktreeJob, slug: string, requestId: string, repo: PhoneGitRepo, recovering: boolean): Promise<PhoneWorktreeOutcome> {
    const cwd = job.cwd;
    const names = phoneWorktreeNames(slug, repo.projectId);
    const leaf = `${PHONE_WORKTREE_DIR_PREFIX}${slug}`;
    // A repeat of an `unknown` request settles its half-made worktree before
    // anything about the main checkout is checked (a rebase in progress there
    // must not strand it); only what recovery removed goes on to be made again.
    // Recovery acts only on what this request's execution record says it
    // created; a request without one never ran the add and wrote nothing.
    if (recovering) {
      const exec = this.receipts.exec(job.owner, requestId);
      const recorded = path.join((await this.parentOf(repo.projectId, false)).parent, leaf);
      if (exec && exec.repo === repo.commonReal && exec.dir === recorded && exec.branch === names.branch) {
        const settled = await this.recover(job, requestId, await this.jobConfig(), repo, exec);
        if (settled) return settled;
      }
    }
    if (!await this.gitIsRecentEnough()) throw new Refusal('git-version-unsupported');
    const config = await this.jobConfig();
    for (const name of IN_PROGRESS) {
      const location = await this.read(cwd, config, 'rev-parse', '--git-path', name);
      if (!location.ok) throw new Refusal('git-operation-failed');
      if (fs.existsSync(path.resolve(cwd, location.stdout.trimEnd()))) throw new Refusal('git-operation-in-progress');
    }
    const head = await this.read(cwd, config, 'rev-parse', '--verify', '-q', 'HEAD^{commit}');
    if (!head.ok) throw new Refusal(head.code === 1 ? 'unborn-head' : 'git-operation-failed');
    const base = head.stdout.trim();
    if (!OID.test(base)) throw new Refusal('git-operation-failed');

    const branchRef = `refs/heads/${names.branch}`;
    const { parent } = await this.parentOf(repo.projectId, false);
    const dir = path.join(parent, leaf);
    const refExists = async (ref: string) => {
      const r = await this.read(cwd, config, 'show-ref', '--verify', '--quiet', ref);
      if (!r.ok && r.code !== 1) throw new Refusal('git-operation-failed');
      return r.ok;
    };

    if (await refExists('refs/heads/phone')) throw new Refusal('branch-namespace-blocked');
    if (await refExists(branchRef)) throw new Refusal('branch-exists');
    if (dir.length > PHONE_WORKTREE_MAX_PATH) throw new Refusal('path-too-long');
    if (this.platform === 'win32' && dir.length > PHONE_WORKTREE_MAX_DIR_WINDOWS) throw new Refusal('path-too-long');
    if (await fs.promises.lstat(dir).then(() => true, () => false)) throw new Refusal('worktree-path-exists');

    // Submodules are not checked out by `worktree add`; refuse rather than
    // hand back a tree with empty submodule directories.
    const gitmodules = await this.read(cwd, config, 'cat-file', '-e', `${base}:.gitmodules`);
    if (gitmodules.ok) throw new Refusal('submodules-unsupported');
    // Content filters run commands on checkout: scan the whole base tree
    // (every path, from the worktree root) for a set `filter` attribute.
    const scanned = await this.scan(repo.worktreeRoot, base, config);
    if (scanned.filters === 'used') throw new Refusal('git-filters-require-desktop');
    if (scanned.filters === 'failed') throw new Refusal('git-operation-failed');
    if (this.platform === 'win32' && (dir.length + 1 + scanned.longest > PHONE_WORKTREE_MAX_PATH ||
        dir.length + 1 + scanned.longestDir > PHONE_WORKTREE_MAX_DIR_WINDOWS)) throw new Refusal('path-too-long');
    // And whatever the scan concluded, no filter driver can run during the
    // checkout: every configured one is disarmed on the command line.
    const filters = await resolveFilterOverrides(cwd, this.git);
    if (!filters.ok) throw new Refusal('git-operation-failed');

    // The execution record reaches disk before anything is written: the
    // branch and the directory were just found absent, so whatever a later
    // recovery finds under these names at this base, this request created.
    try { this.receipts.journal(job.owner, requestId, { phase: 'add', repo: repo.commonReal, dir, branch: names.branch, base }); } catch { throw new NotRun(); }
    const { made } = await this.parentOf(repo.projectId, true);
    if (await fs.promises.lstat(dir).then(() => true, () => false)) {
      await this.removeEmpty(made);
      throw new Refusal('worktree-path-exists');
    }
    const add = await this.addGit(gitArgv(...config, ...filters.args, ...phoneWorktreeAddArgs(names.branch, dir, base)), cwd);
    const made1 = await this.git(gitArgv(...config, 'rev-parse', '--verify', '-q', branchRef), cwd);
    if (add.ok && made1.ok && made1.stdout.trim() === base && await canonicalPath(dir) === dir) {
      return { state: 'created', projectId: repo.projectId, branch: names.branch, base, cwd: dir, leaf };
    }
    // The add ran (or was killed) and did not finish cleanly. Only when it
    // is certain nothing was left behind is this a refusal; otherwise the
    // outcome is unknown and a repeat of the same request recovers it.
    const dirLeft = await fs.promises.lstat(dir).then(() => true, () => false);
    const listed = await listWorktrees(this.git, cwd).catch(() => null);
    const registered = listed === null ? null : listed.some((w) => path.resolve(w.path) === dir);
    // `rev-parse --verify -q` answers 1 for a missing ref; anything else decides nothing.
    let branchLeft: boolean | null = made1.ok ? true : made1.ran !== false && made1.code === 1 ? false : null;
    // Git answered with a failure and removed its checkout, keeping only the
    // branch it had just created (e.g. objects it may not fetch): that branch
    // is this request's and untouched, so drop it and report a plain refusal.
    if (add.ran !== false && !dirLeft && registered === false && branchLeft === true &&
        await this.dropOwnBranch(cwd, config, branchRef, base)) {
      branchLeft = false;
    }
    // Directories made for this job go again whenever they are still empty.
    if (!dirLeft) await this.removeEmpty(made);
    if (branchLeft === false && !dirLeft && registered === false) throw new Refusal('git-operation-failed');
    return { state: 'unknown', error: 'git-outcome-unknown' };
  }

  /** The repository's worktrees, or null when git could not list them. */
  private async worktreesOf(cwd: string): Promise<WorktreeRow[] | null> {
    return listWorktrees(this.git, cwd).catch(() => null);
  }

  /** Whether a live session's current or spawn directory is `dir` or inside it. */
  private async inUse(dir: string): Promise<boolean> {
    const cwds = await this.opts.liveCwds?.() ?? [];
    for (const cwd of cwds) {
      const real = await canonicalPath(cwd);
      if (real === dir || real.startsWith(dir + path.sep)) return true;
    }
    return false;
  }

  /**
   * The administrative directory of the linked worktree at `dir`, read from
   * its `.git` file and required to lie under this repository's
   * `worktrees/`: where git keeps that checkout's index and index lock (what
   * `git rev-parse --git-path index` names from inside it). `none` when the
   * `.git` file is not there yet; null when it cannot be read or points
   * anywhere else.
   */
  private async adminDir(repo: PhoneGitRepo, dir: string): Promise<string | 'none' | null> {
    let text: string;
    try { text = await fs.promises.readFile(path.join(dir, '.git'), 'utf8'); } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : null;
    }
    const m = /^gitdir: (.+?)\r?\n?$/.exec(text);
    if (!m) return null;
    const admin = await canonicalPath(path.resolve(dir, m[1]));
    return path.dirname(admin) === path.join(repo.commonReal, 'worktrees') ? admin : null;
  }

  /**
   * A repeat of an `unknown` request that recorded running the add. Only the
   * checkout at the recorded directory and the recorded branch are looked
   * at, and only what this request created is ever removed:
   *
   * - a finished, clean checkout of the branch at the recorded base is
   *   adopted as created, also when git left it locked `initializing`
   *   because the command that made it died first;
   * - a checkout git is still writing (its index lock exists), or one a
   *   process still holds on Windows, is left exactly as it is and the
   *   request stays retryable, as it does when any step here does not run;
   * - a checkout git left locked `initializing` that holds nothing but what
   *   the add wrote before its checkout began is removed (git writes the
   *   checkout's files under its index lock and the index after them, so
   *   with neither present no file of the tree was written yet) — never
   *   while a session runs inside it;
   * - anything else there (changes, another branch, another lock reason, a
   *   session in it) is kept and refused `worktree-path-exists`, for the
   *   desktop cleanup list;
   * - the recorded branch, checked out nowhere, still at the recorded base
   *   and never moved since its creation, is deleted (compare-and-swap).
   *
   * Null when the request may now be made again; the normal refusals then
   * report whatever is still there.
   */
  private async recover(job: PhoneWorktreeJob, requestId: string, config: readonly string[], repo: PhoneGitRepo, exec: PhoneWorktreeExec): Promise<PhoneWorktreeOutcome | null> {
    const cwd = job.cwd;
    const { dir, branch } = exec;
    let worktrees = await this.worktreesOf(cwd);
    if (!worktrees) return RETRY;
    const here = worktrees.find((w) => path.resolve(w.path) === dir);
    if (here) {
      const settled = await this.settleCheckout(job, requestId, config, repo, exec, here);
      if (settled) return settled;
      worktrees = await this.worktreesOf(cwd);
      if (!worktrees) return RETRY;
    }
    const branchRef = `refs/heads/${branch}`;
    const tip = await this.read(cwd, config, 'rev-parse', '--verify', '-q', branchRef);
    if (!tip.ok && tip.code !== 1) return RETRY;
    if (tip.ok && !worktrees.some((w) => w.branch === branch)) await this.dropOwnBranch(cwd, config, branchRef, exec.base);
    return null;
  }

  /** The recorded checkout, registered with git: adopted, left, or removed (null). */
  private async settleCheckout(job: PhoneWorktreeJob, requestId: string, config: readonly string[], repo: PhoneGitRepo,
    exec: PhoneWorktreeExec, here: WorktreeRow): Promise<PhoneWorktreeOutcome | null> {
    const cwd = job.cwd;
    const { dir, branch } = exec;
    const keep = () => { throw new Refusal('worktree-path-exists'); };
    const removeRegistration = async (): Promise<PhoneWorktreeOutcome | null> => {
      const removed = await this.readWith(this.longGit, cwd, config, 'worktree', 'remove', '--force', '--force', '--', dir);
      return removed.ok ? null : RETRY;
    };
    const dirLeft = await fs.promises.lstat(dir).then(() => true, () => false);
    if (!here.locked) {
      // Registered, directory gone: only that registration goes.
      if (here.prunable && !dirLeft) return removeRegistration();
      if (exec.phase === 'add' && here.branch === branch) {
        const adopted = await this.adoptClean(dir, config, repo, exec);
        if (adopted) return adopted;
      }
      // A finished checkout that is not clean holds someone's work.
      return keep();
    }
    if (here.lockReason !== 'initializing') return keep();
    // Locked by the add, directory gone (a removal that stopped between the
    // directory and its registration): nothing in it to keep.
    if (!dirLeft) return removeRegistration();
    // On Windows a checkout can outlive the daemon that started it: the
    // daemon's process job ends `git worktree add` with it, not the `git
    // reset --hard` it spawned. Touch nothing while a process holds it.
    if (await this.directoryHold(dir).catch((): DirectoryHold => 'free') !== 'free') return RETRY;
    const admin = await this.adminDir(repo, dir);
    if (admin === null) return keep();
    const exists = (p: string) => fs.promises.lstat(p).then(() => true, () => false);
    // A git still writing the checkout holds its index lock.
    if (admin !== 'none' && await exists(path.join(admin, 'index.lock'))) return RETRY;
    // Once that writer is done the checkout is complete: adopt it, then drop the lock.
    if (exec.phase === 'add' && admin !== 'none' && here.branch === branch) {
      const adopted = await this.adoptClean(dir, config, repo, exec);
      if (adopted) return (await this.read(cwd, config, 'worktree', 'unlock', '--', dir)).ok ? adopted : RETRY;
    }
    if (await this.inUse(dir)) return keep();
    if (exec.phase === 'add') {
      if (admin !== 'none' && here.branch !== branch) return keep();
      // With an index the checkout finished, and what differs from it is
      // someone's work. Without one git wrote no file of the tree yet, so
      // anything besides its `.git` file is someone else's.
      if (admin !== 'none' && await exists(path.join(admin, 'index'))) return keep();
      const entries = await fs.promises.readdir(dir).catch(() => null);
      if (entries === null) return RETRY;
      if (entries.some((name) => name !== '.git')) return keep();
      // The removal is recorded first: one cut short is finished by the next repeat.
      try { this.receipts.journal(job.owner, requestId, { ...exec, phase: 'remove' }); } catch { return RETRY; }
    }
    return removeRegistration();
  }

  /** `created` when `dir` has the recorded branch checked out at the recorded base with nothing changed. */
  private async adoptClean(dir: string, config: readonly string[], repo: PhoneGitRepo, exec: PhoneWorktreeExec): Promise<PhoneWorktreeOutcome | null> {
    const tip = await this.read(dir, config, 'rev-parse', '--verify', '-q', `refs/heads/${exec.branch}`);
    if (!tip.ok || tip.stdout.trim() !== exec.base) return null;
    // The status reads every file, so the filter drivers are disarmed as for the add.
    const filters = await resolveFilterOverrides(dir, this.git);
    if (!filters.ok) throw new NotRun();
    const status = await this.readWith(this.longGit, dir, [...config, ...filters.args], 'status', '--porcelain', '--untracked-files=all');
    const checkedOut = await this.read(dir, config, 'rev-parse', '--verify', '-q', 'HEAD');
    if (status.ok && status.stdout === '' && checkedOut.ok && checkedOut.stdout.trim() === exec.base) {
      return { state: 'created', projectId: repo.projectId, branch: exec.branch, base: exec.base, cwd: dir, leaf: path.basename(dir) };
    }
    return null;
  }

  /**
   * Delete `ref`, which this request's record says it created at `oid`, only
   * if it still points there and has not moved since: its reflog holds at most
   * the single entry of its creation (none at all when the repository keeps
   * no reflogs, `core.logAllRefUpdates=false`; the record then decides).
   * Compare and swap, so a concurrent update wins.
   */
  private async dropOwnBranch(cwd: string, config: readonly string[], ref: string, oid: string): Promise<boolean> {
    const log = await this.read(cwd, config, 'reflog', 'show', '--format=%H', ref, '--');
    if (!log.ok) return false;
    const entries = log.stdout.split('\n').filter(Boolean);
    if (entries.length > 1 || (entries.length === 1 && entries[0] !== oid)) return false;
    return (await this.read(cwd, config, 'update-ref', '-d', ref, oid)).ok;
  }
}
