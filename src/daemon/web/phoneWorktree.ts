import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import {
  buildGitEnv, createGitRunner, gitArgv, resolveFilterOverrides, GIT_MAX_BUFFER_BYTES,
  type GitRunner, type GitRunResult,
} from './sessionDiff';
import { canonicalPath, listWorktrees, resolvePhoneGitRepo, type PhoneGitRepo } from './phoneGitRead';
import { PhoneWorktreeReceipts, ReceiptCapacityError, type PhoneWorktreeOutcome } from './phoneWorktreeReceipts';
import {
  parseWorktreeCreateBody, phoneWorktreeAddArgs, phoneWorktreeNames, PHONE_WORKTREE_DIR_PREFIX,
  type PhoneWorktreeReceipt, type PhoneWorktreeRefusal,
} from '../../shared/phoneGitV1';

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

/** What the whole-tree scan found: whether any path's `filter` attribute is set, and the longest path. */
export interface TreeScan { filters: 'used' | 'unused' | 'failed'; longest: number }
export type TreeScanner = (cwd: string, oid: string, config: readonly string[]) => Promise<TreeScan>;

/**
 * `git ls-tree -r --full-tree` piped into `git check-attr --source=<oid>
 * --stdin filter` (git 2.40+), over the WHOLE tree of the commit, from the
 * worktree root. Stops at the first path whose filter is set. Streams, so a
 * large tree is never buffered whole; also measures the longest path.
 */
export const scanTree: TreeScanner = (cwd, oid, config) => new Promise((resolve) => {
  const env = buildGitEnv();
  const argv = (...args: string[]) => gitArgv(...config, ...args);
  const list = spawn('git', argv('ls-tree', '-r', '-z', '--full-tree', '--name-only', oid), { cwd, env, windowsHide: true });
  const check = spawn('git', argv('check-attr', `--source=${oid}`, '-z', '--stdin', 'filter'), { cwd, env, windowsHide: true });
  let settled = false;
  let longest = 0;
  let listRest = '';
  const finish = (filters: TreeScan['filters']) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    list.kill(); check.kill();
    resolve({ filters, longest });
  };
  const timer = setTimeout(() => finish('failed'), PHONE_WORKTREE_SCAN_TIMEOUT_MS);
  list.stdout.setEncoding('utf8');
  list.stdout.on('data', (chunk: string) => {
    const names = (listRest + chunk).split('\0');
    listRest = names.pop() ?? '';
    for (const name of names) longest = Math.max(longest, name.length);
    if (!check.stdin.destroyed) check.stdin.write(names.map((n) => `${n}\0`).join(''));
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

/** The long-bounded runner for `worktree add` alone. */
function createAddRunner(): GitRunner {
  const env = buildGitEnv();
  return (args, cwd) => new Promise<GitRunResult>((resolve) => {
    execFile('git', [...args], { cwd, env, timeout: PHONE_WORKTREE_ADD_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      (err, stdout, stderr) => resolve({
        ok: !err,
        ran: !err || (typeof err.code === 'number' && err.killed !== true),
        code: !err ? 0 : typeof err.code === 'number' && err.killed !== true ? err.code : undefined,
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
      }));
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
  private readonly platform: NodeJS.Platform;
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
    this.platform = opts.platform ?? process.platform;
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
      outcome = error instanceof Refusal
        ? { state: 'refused', error: error.tag }
        : { state: 'unknown', error: 'git-outcome-unknown' };
    }
    try {
      this.receipts.settle(job.owner, requestId, outcome);
      this.opts.audit?.(job.deviceId, outcome.state === 'created' ? 'created' : outcome.error);
    } catch { /* the receipt stays in memory; an audit line is best-effort */ }
  }

  private async create(job: PhoneWorktreeJob, slug: string, requestId: string, recovering: boolean): Promise<PhoneWorktreeOutcome> {
    let repo: PhoneGitRepo | null;
    try { repo = await resolvePhoneGitRepo(job.cwd, this.git); } catch { throw new Refusal('git-operation-failed'); }
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
    const result = await this.git(gitArgv(...config, ...args), cwd);
    if (!result.ok && result.ran === false) throw new Refusal('git-operation-failed');
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
    } catch { throw new Refusal('git-operation-failed'); }
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

    const names = phoneWorktreeNames(slug, repo.projectId);
    const branchRef = `refs/heads/${names.branch}`;
    const { parent } = await this.parentOf(repo.projectId, false);
    const leaf = `${PHONE_WORKTREE_DIR_PREFIX}${slug}`;
    const dir = path.join(parent, leaf);
    const refExists = async (ref: string) => {
      const r = await this.read(cwd, config, 'show-ref', '--verify', '--quiet', ref);
      if (!r.ok && r.code !== 1) throw new Refusal('git-operation-failed');
      return r.ok;
    };

    if (recovering) {
      const adopted = await this.recover(cwd, config, repo, names.branch, dir);
      if (adopted) return adopted;
    }

    if (await refExists('refs/heads/phone')) throw new Refusal('branch-namespace-blocked');
    if (await refExists(branchRef)) throw new Refusal('branch-exists');
    if (dir.length > PHONE_WORKTREE_MAX_PATH) throw new Refusal('path-too-long');
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
    if (this.platform === 'win32' && dir.length + 1 + scanned.longest > PHONE_WORKTREE_MAX_PATH) throw new Refusal('path-too-long');
    // And whatever the scan concluded, no filter driver can run during the
    // checkout: every configured one is disarmed on the command line.
    const filters = await resolveFilterOverrides(cwd, this.git);
    if (!filters.ok) throw new Refusal('git-operation-failed');

    // The pending entry reaches disk before anything is written.
    try { this.receipts.journal(); } catch { throw new Refusal('git-operation-failed'); }
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
    // left nothing behind is this a refusal; otherwise the outcome is unknown
    // and a repeat of the same request recovers it.
    const leftovers = made1.ok || await fs.promises.lstat(dir).then(() => true, () => false) ||
      ((await listWorktrees(this.git, cwd).catch(() => null)) ?? []).some((w) => path.resolve(w.path) === dir);
    if (leftovers) return { state: 'unknown', error: 'git-outcome-unknown' };
    await this.removeEmpty(made);
    throw new Refusal('git-operation-failed');
  }

  /**
   * A repeat of an `unknown` request. A finished, clean checkout of
   * `phone/<slug>` at the phone directory is adopted as created. A checkout
   * git left locked mid-creation is removed, and a `phone/<slug>` branch that
   * never moved since it was created and is checked out nowhere is deleted
   * (compare-and-swap on its tip), so the create can run again. Anything
   * else — a directory with changes in it, a branch with history — is left
   * for the operator, and the normal refusals report it.
   */
  private async recover(cwd: string, config: readonly string[], repo: PhoneGitRepo, branch: string, dir: string): Promise<PhoneWorktreeOutcome | null> {
    await this.read(cwd, config, 'worktree', 'prune');
    let worktrees = (await listWorktrees(this.git, cwd)) ?? [];
    const here = worktrees.find((w) => path.resolve(w.path) === dir);
    const branchRef = `refs/heads/${branch}`;
    if (here && !here.locked && here.branch === branch) {
      const tip = await this.read(cwd, config, 'rev-parse', '--verify', '-q', branchRef);
      const status = await this.read(dir, config, 'status', '--porcelain', '--untracked-files=all');
      const checkedOut = await this.read(dir, config, 'rev-parse', '--verify', '-q', 'HEAD');
      if (tip.ok && status.ok && status.stdout === '' && checkedOut.ok && checkedOut.stdout.trim() === tip.stdout.trim()) {
        return { state: 'created', projectId: repo.projectId, branch, base: tip.stdout.trim(), cwd: dir, leaf: path.basename(dir) };
      }
    }
    // A finished checkout that is not clean holds someone's work: leave it.
    if (here && !here.locked) throw new Refusal('worktree-path-exists');
    if (here?.locked) {
      await this.read(cwd, config, 'worktree', 'unlock', '--', dir);
      const removed = await this.read(cwd, config, 'worktree', 'remove', '--force', '--', dir);
      if (!removed.ok) throw new Refusal('git-operation-failed');
      worktrees = (await listWorktrees(this.git, cwd)) ?? [];
    }
    const tip = await this.read(cwd, config, 'rev-parse', '--verify', '-q', branchRef);
    if (tip.ok && !worktrees.some((w) => w.branch === branch)) {
      const log = await this.read(cwd, config, 'reflog', 'show', '--format=%H', branchRef, '--');
      const entries = log.ok ? log.stdout.split('\n').filter(Boolean) : [];
      if (entries.length === 1 && entries[0] === tip.stdout.trim()) {
        await this.read(cwd, config, 'update-ref', '-d', branchRef, tip.stdout.trim());
      }
    }
    return null;
  }
}
