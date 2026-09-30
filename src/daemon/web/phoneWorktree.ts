import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { buildGitEnv, createGitRunner, gitArgv, GIT_MAX_BUFFER_BYTES, GIT_TIMEOUT_MS, type GitRunner, type GitRunResult } from './sessionDiff';
import { WRITE_CONFIG } from './sessionGit';
import { resolvePhoneGitRepo, type PhoneGitRepo } from './phoneGitRead';
import { PhoneWorktreeReceipts, type PhoneWorktreeOutcome } from './phoneWorktreeReceipts';
import {
  parseWorktreeCreateBody, phoneWorktreeAddArgs, phoneWorktreeNames,
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
/** Longest worktree directory the daemon will create (Windows MAX_PATH). */
export const PHONE_WORKTREE_MAX_PATH = 260;

/**
 * Every write-side command: hooks off (no repository hook runs), and the
 * GLOBAL attributes file off, so only the tree's own `.gitattributes` and
 * `info/attributes` — the ones the filter check reads — can select a filter.
 */
const JOB_CONFIG = [...WRITE_CONFIG, '-c', 'core.attributesFile=/dev/null'];
const jobArgv = (...args: string[]) => gitArgv(...JOB_CONFIG, ...args);
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];

class Refusal extends Error {
  constructor(readonly tag: PhoneWorktreeRefusal) { super(tag); }
}

/** Does any path of `oid`'s tree carry a `filter` attribute? `failed` when git could not say. */
export type AttributeScan = (cwd: string, oid: string) => Promise<'used' | 'unused' | 'failed'>;

/**
 * `git ls-tree -r` piped into `git check-attr --source=<oid> --stdin filter`
 * (git 2.40+), stopping at the first path whose filter is set. Streams, so a
 * large tree is never buffered whole.
 */
export const scanTreeFilters: AttributeScan = (cwd, oid) => new Promise((resolve) => {
  const env = buildGitEnv();
  const list = spawn('git', jobArgv('ls-tree', '-r', '-z', '--name-only', oid), { cwd, env, windowsHide: true });
  const check = spawn('git', jobArgv('check-attr', `--source=${oid}`, '-z', '--stdin', 'filter'), { cwd, env, windowsHide: true });
  let settled = false;
  const finish = (answer: 'used' | 'unused' | 'failed') => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    list.kill(); check.kill();
    resolve(answer);
  };
  const timer = setTimeout(() => finish('failed'), GIT_TIMEOUT_MS);
  list.stdout.pipe(check.stdin);
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

export interface PhoneWorktreeSlots { acquire(): boolean; release(): void }

export interface PhoneWorktreeOptions {
  wmuxDir: string;
  git?: GitRunner;
  addGit?: GitRunner;
  scanFilters?: AttributeScan;
  /** One audit line per job that reached the background: device id and outcome tag. */
  audit?: (deviceId: string, reason: string) => void;
  now?: () => number;
}

export class PhoneWorktreeService {
  readonly receipts: PhoneWorktreeReceipts;
  private readonly git: GitRunner;
  private readonly addGit: GitRunner;
  private readonly scanFilters: AttributeScan;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: PhoneWorktreeOptions) {
    this.receipts = new PhoneWorktreeReceipts(opts.wmuxDir, opts.now);
    this.git = opts.git ?? createGitRunner();
    this.addGit = opts.addGit ?? createAddRunner();
    this.scanFilters = opts.scanFilters ?? scanTreeFilters;
  }

  get available(): boolean { return this.receipts.available; }

  /** `GET …/git/worktree/<requestId>`. */
  receipt(owner: string, sessionId: string, requestId: string): PhoneWorktreeReceipt {
    const found = this.receipts.find(owner, requestId);
    return found && found.sessionId === sessionId ? found.receipt : { requestId, state: 'none' };
  }

  /**
   * `POST …/git/worktree`: validate, replay or journal, then start the job.
   * `done` resolves when a started job has settled (tests and shutdown).
   */
  submit(job: PhoneWorktreeJob, slots: PhoneWorktreeSlots): { status: number; body: object; done?: Promise<void> } {
    if (!this.available) return { status: 503, body: { error: 'git-receipts-unavailable' } };
    const parsed = parseWorktreeCreateBody(job.body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const { slug, requestId } = parsed.value;
    const previous = this.receipts.find(job.owner, requestId);
    if (previous) {
      if (previous.sessionId !== job.sessionId || previous.slug !== slug) return { status: 409, body: { error: 'request-id-conflict' } };
      return { status: 200, body: { ...previous.receipt, replayed: true } };
    }
    if (!slots.acquire()) return { status: 429, body: { error: 'git-busy' } };
    try {
      this.receipts.begin(job.owner, requestId, job.sessionId, slug);
    } catch {
      slots.release();
      return { status: 503, body: { error: 'git-receipts-unavailable' } };
    }
    const done = this.run(job, slug, requestId).finally(() => slots.release());
    return { status: 202, body: { requestId, replayed: false, state: 'pending' }, done };
  }

  private async run(job: PhoneWorktreeJob, slug: string, requestId: string): Promise<void> {
    let outcome: PhoneWorktreeOutcome;
    try {
      outcome = await this.create(job.cwd, slug);
    } catch (error) {
      outcome = error instanceof Refusal
        ? { state: 'refused', error: error.tag }
        : { state: 'unknown', error: 'git-outcome-unknown' };
    }
    this.receipts.settle(job.owner, requestId, outcome);
    this.opts.audit?.(job.deviceId, outcome.state === 'created' ? 'created' : outcome.error);
  }

  private async create(cwd: string, slug: string): Promise<PhoneWorktreeOutcome> {
    let repo: PhoneGitRepo | null;
    try { repo = await resolvePhoneGitRepo(cwd, this.git); } catch { throw new Refusal('git-operation-failed'); }
    if (!repo) throw new Refusal('not-a-git-repo');
    const key = await fs.promises.realpath(repo.commonDir).catch(() => repo.commonDir);
    // One job at a time per repository: two worktrees of one repository share
    // its refs and its worktree registry.
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.createLocked(cwd, slug, repo));
    const tail = work.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return work;
  }

  private async read(cwd: string, ...args: string[]): Promise<GitRunResult> {
    const result = await this.git(jobArgv(...args), cwd);
    if (!result.ok && result.ran === false) throw new Refusal('git-operation-failed');
    return result;
  }

  /** Every refusal is decided here, before anything is written. */
  private async createLocked(cwd: string, slug: string, repo: PhoneGitRepo): Promise<PhoneWorktreeOutcome> {
    for (const name of IN_PROGRESS) {
      const location = await this.read(cwd, 'rev-parse', '--git-path', name);
      if (!location.ok) throw new Refusal('git-operation-failed');
      if (fs.existsSync(path.resolve(cwd, location.stdout.trimEnd()))) throw new Refusal('git-operation-in-progress');
    }
    const head = await this.read(cwd, 'rev-parse', '--verify', '-q', 'HEAD^{commit}');
    if (!head.ok) throw new Refusal(head.code === 1 ? 'unborn-head' : 'git-operation-failed');
    const base = head.stdout.trim();
    if (!OID.test(base)) throw new Refusal('git-operation-failed');

    const names = phoneWorktreeNames(slug, repo.projectId);
    const refExists = async (ref: string) => {
      const r = await this.read(cwd, 'show-ref', '--verify', '--quiet', ref);
      if (!r.ok && r.code !== 1) throw new Refusal('git-operation-failed');
      return r.ok;
    };
    if (await refExists('refs/heads/phone')) throw new Refusal('branch-namespace-blocked');
    if (await refExists(`refs/heads/${names.branch}`)) throw new Refusal('branch-exists');
    const dir = path.join(this.opts.wmuxDir, ...names.relativeDir.split('/'));
    if (dir.length > PHONE_WORKTREE_MAX_PATH) throw new Refusal('path-too-long');
    if (fs.existsSync(dir) || await fs.promises.lstat(dir).then(() => true, () => false)) throw new Refusal('worktree-path-exists');

    // Submodules are not checked out by `worktree add`; refuse rather than
    // hand back a tree with empty submodule directories.
    const gitmodules = await this.read(cwd, 'cat-file', '-e', `${base}:.gitmodules`);
    if (gitmodules.ok) throw new Refusal('submodules-unsupported');
    if (await this.usesFilters(cwd, base)) throw new Refusal('git-filters-require-desktop');

    await fs.promises.mkdir(path.dirname(dir), { recursive: true }).catch(() => { throw new Refusal('git-operation-failed'); });
    const add = await this.addGit(jobArgv(...phoneWorktreeAddArgs(names.branch, dir, base)), cwd);
    if (!add.ok) {
      // Killed (timeout, signal) mid-checkout: the branch or the directory may
      // or may not exist. Only git saying no is a refusal.
      if (add.ran === false) return { state: 'unknown', error: 'git-outcome-unknown' };
      throw new Refusal('git-operation-failed');
    }
    const made = await this.git(jobArgv('rev-parse', '--verify', '-q', `refs/heads/${names.branch}`), cwd);
    if (!made.ok || made.stdout.trim() !== base) return { state: 'unknown', error: 'git-outcome-unknown' };
    return { state: 'created', projectId: repo.projectId, branch: names.branch, base, cwd: dir, leaf: path.basename(dir) };
  }

  /**
   * Content filters run commands on checkout. Only a `filter=` attribute some
   * path of the base tree actually uses refuses; a global `git lfs install`
   * with no `filter=lfs` in the tree does not. Cheap text pass first, the
   * per-path check only when some attributes file mentions `filter=`.
   */
  private async usesFilters(cwd: string, base: string): Promise<boolean> {
    const grep = await this.read(cwd, 'grep', '-l', '-I', '--no-textconv', '-F', '-e', 'filter=', base, '--',
      '.gitattributes', ':(glob)**/.gitattributes');
    if (!grep.ok && grep.code !== 1) throw new Refusal('git-operation-failed');
    let mentioned = grep.ok && grep.stdout.trim().length > 0;
    if (!mentioned) {
      const info = await this.read(cwd, 'rev-parse', '--git-path', 'info/attributes');
      if (!info.ok) throw new Refusal('git-operation-failed');
      mentioned = await fs.promises.readFile(path.resolve(cwd, info.stdout.trimEnd()), 'utf8')
        .then((text) => text.includes('filter='), () => false);
    }
    if (!mentioned) return false;
    // A filter we could not rule out is treated as used.
    return (await this.scanFilters(cwd, base)) !== 'unused';
  }
}
