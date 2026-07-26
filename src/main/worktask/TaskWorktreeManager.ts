/**
 * TaskWorktreeManager — J1 §3 D3. Creates dedicated git worktrees for fan-out tasks.
 *
 * Reuse from company/WorktreeManager (orphaned duplicate) is validation utils only
 * (validateGitRef·validatePath — flag injection·traversal defense); §6.J pitfall
 * list (dedicated root·serial queue·dirty preserve·edge fail-closed·path length) is new implementation.
 *
 * Core contracts:
 *   - Dedicated root: `${getWmuxHomeDir()}/worktrees/{repoHash}/{taskSlug}` — no hardcoded
 *     `~/.wmux`; inherits dev/dogfood suffix isolation via getWmuxHomeDir() (C4).
 *   - repoHash = 12-char hash of repo root realpath (J0 normalizeWorktreePath comment
 *     "realpath is caller's job" fulfillment point).
 *   - taskSlug = `{title slug 24 chars}-{taskId suffix 8 chars}` (collisions absorbed by taskId).
 *   - branch = `wtask/{taskSlug}` — explicit error on existing branch conflict (no auto suffix).
 *   - per-repo serial queue: repoHash mutex serializes add/remove (blocks git index.lock contention).
 *   - dirty rejection: porcelain check on remove entry → reject removal + return preserved if dirty.
 *   - edge fail-closed: bare·submodule·LFS·non-repo·path over 260 chars → explicit error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { getWmuxHomeDir } from '../../shared/constants';
import { getGitExecEnv } from '../../shared/execEnv';
import { resolveGitToplevel } from '../git/git';

const execFileAsync = promisify(execFile);

/** Windows MAX_PATH guard — root+slug combined upper bound (§3 review G2). */
const MAX_WORKTREE_PATH_LEN = 260;
/** taskSlug: title slug max length (§3). */
const TITLE_SLUG_MAX = 24;
/** taskSlug: taskId suffix length (§3 — collision absorption entropy). */
const TASK_ID_SUFFIX_LEN = 8;

/**
 * git ref (branch name) validation — flag injection·traversal defense (inherited from company/WorktreeManager).
 */
function validateGitRef(ref: string, label: string): string {
  if (!ref || ref.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const trimmed = ref.trim();
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`);
  }
  if (trimmed.includes('..')) {
    throw new Error(`${label} must not contain '..'`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  if (trimmed.length > 200) {
    throw new Error(`${label} is too long (max 200 characters)`);
  }
  return trimmed;
}

/**
 * Filesystem path validation (inherited from company/WorktreeManager) — flag injection·control char defense
 * then resolve to absolute path.
 */
function validatePath(p: string, label: string): string {
  if (!p || p.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const trimmed = p.trim();
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return path.resolve(trimmed);
}

/** title → slug (lowercase·alphanumeric·hyphen, max TITLE_SLUG_MAX chars). */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TITLE_SLUG_MAX)
    .replace(/-+$/g, '');
}

/** Last 8 chars of taskId (= random segment) — collision absorption. */
export function taskIdSuffix(taskId: string): string {
  return taskId.replace(/^wtask-/, '').slice(-TASK_ID_SUFFIX_LEN);
}

/**
 * worktree path → meta dir derivation (J3 §1·§3 — inverse of preflight path rules).
 * preflight derives `worktreePath = {root}/{slug}`·`metaDir = {root}/.meta/{slug}` so
 * `dirname(worktreePath)/.meta/basename(worktreePath)` is consistent.
 * Cleanup scan (task.json reverse trace)·unsent retry (prompt.md existence check) use worktreePath
 * as single source to recover meta dir.
 */
export function metaDirForWorktree(worktreePath: string): string {
  return path.join(path.dirname(worktreePath), '.meta', path.basename(worktreePath));
}

/** taskSlug = `{titleSlug}-{taskIdSuffix}`. suffix only when titleSlug empty. */
export function buildTaskSlug(title: string, taskId: string): string {
  const slug = titleToSlug(title);
  const suffix = taskIdSuffix(taskId);
  return slug.length > 0 ? `${slug}-${suffix}` : suffix;
}

/** Derived path bundle for fan-out task worktree (computed·validated by preflight). */
export interface TaskWorktreePlan {
  /** Repo root realpath. */
  repoRoot: string;
  /** 12-char hash of repo root realpath. */
  repoHash: string;
  /** `{titleSlug}-{taskIdSuffix}`. */
  taskSlug: string;
  /** Dedicated worktree path. */
  worktreePath: string;
  /** `wtask/{taskSlug}`. */
  branch: string;
  /** Meta file directory for prompts etc. (outside worktree — diff cleanliness §4). */
  metaDir: string;
}

export type PreflightResult =
  | { ok: true; plan: TaskWorktreePlan }
  | { ok: false; error: string };

export type CreateResult =
  | { ok: true; worktreePath: string; branch: string }
  | { ok: false; error: string };

export type RemoveResult =
  | { ok: true }
  | { ok: false; error: string; preserved?: boolean };

/**
 * Worktree manager with per-repo serial queue. Instance reused for process lifetime
 * (must maintain repoHash → mutex chain).
 */
export class TaskWorktreeManager {
  /** repoHash → write chain (§3 per-repo serial queue — index.lock contention block). */
  private readonly repoChains = new Map<string, Promise<unknown>>();

  /** Injectable git runner (tests) — default execFile. */
  private readonly runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(opts?: {
    runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  }) {
    this.runGit =
      opts?.runGit ??
      (async (args, cwd) => {
        const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 30000, env: getGitExecEnv() });
        return { stdout, stderr };
      });
  }

  /**
   * Preflight (§2 ⓪ — repo validity once upfront). Ineligible repos must not create tasks·channels
   * so FanOutService uses this to reject entire fan-out.
   *   - non-repo·missing git → reject.
   *   - bare repo·submodule·LFS → reject (support later, no silent half behavior).
   *   - dedicated root writable + path length (260 chars) validation.
   *   - return branch·slug·path derivation on success.
   */
  async preflight(
    repoPathRaw: string,
    title: string,
    taskId: string,
    opts?: { checkBranchConflict?: boolean },
  ): Promise<PreflightResult> {
    let repoInput: string;
    try {
      repoInput = validatePath(repoPathRaw, 'repoPath');
    } catch (err) {
      return { ok: false, error: `preflight: ${(err as Error).message}` };
    }

    // Confirm repo root (non-repo·missing git fail-closed). --show-toplevel fails on bare.
    let gitFailed = false;
    const repoRoot = await resolveGitToplevel(repoInput, async (args) => {
      try {
        const result = await this.runGit(args, repoInput);
        return { ...result, code: 0 };
      } catch (error) {
        gitFailed = true;
        return { stdout: '', stderr: String(error), code: 1 };
      }
    });
    if (!repoRoot && gitFailed) {
      return { ok: false, error: `preflight: not a git repository or git unavailable: ${repoInput}` };
    }
    if (!repoRoot) {
      return { ok: false, error: 'preflight: not a git repository (empty toplevel)' };
    }

    // Reject bare repo (§3 edge fail-closed).
    try {
      const { stdout } = await this.runGit(['rev-parse', '--is-bare-repository'], repoRoot);
      if (stdout.trim() === 'true') {
        return { ok: false, error: 'preflight: bare repositories are not supported (J1)' };
      }
    } catch {
      return { ok: false, error: 'preflight: failed to determine repository kind' };
    }

    // Reject repo with submodules (§3). Detect via .gitmodules presence (conservative fail-closed).
    if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
      return { ok: false, error: 'preflight: repositories with submodules are not supported (J1)' };
    }

    // Reject LFS (§3). fail-closed when .gitattributes has filter=lfs.
    const gitattr = path.join(repoRoot, '.gitattributes');
    if (fs.existsSync(gitattr)) {
      try {
        const content = fs.readFileSync(gitattr, 'utf8');
        if (/filter=lfs/.test(content)) {
          return { ok: false, error: 'preflight: git-LFS repositories are not supported (J1)' };
        }
      } catch {
        // Read failure → cannot determine LFS — conservatively reject, do not pass through.
        return { ok: false, error: 'preflight: failed to inspect .gitattributes' };
      }
    }

    // 12-char hash of repo root realpath.
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(repoRoot);
    } catch {
      realRoot = repoRoot;
    }
    const repoHash = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 12);

    // Path derivation.
    const taskSlug = buildTaskSlug(title, taskId);
    const root = `${getWmuxHomeDir()}/worktrees/${repoHash}`;
    const worktreePath = path.join(root, taskSlug);
    const metaDir = path.join(root, '.meta', taskSlug);
    const branch = `wtask/${taskSlug}`;

    // branch·path validation (flag injection·traversal — inherited utils).
    try {
      validateGitRef(branch, 'branch');
      validatePath(worktreePath, 'worktreePath');
    } catch (err) {
      return { ok: false, error: `preflight: ${(err as Error).message}` };
    }

    // Windows MAX_PATH guard (§3 review G2).
    if (worktreePath.length > MAX_WORKTREE_PATH_LEN) {
      return {
        ok: false,
        error: `preflight: worktree path exceeds ${MAX_WORKTREE_PATH_LEN} characters (${worktreePath.length}); shorten the title or enable core.longpaths`,
      };
    }

    // Verify dedicated root writable (attempt directory creation).
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      return { ok: false, error: `preflight: dedicated worktree root not writable: ${(err as Error).message}` };
    }

    // Branch conflict pre-check (F3 — used when pre-validating all titles). createWorktree re-checks
    // under lock but global preflight must filter ineligible tasks before mission.start to honor
    // "ineligible → zero tasks created" contract — must check here too.
    if (opts?.checkBranchConflict) {
      try {
        await this.runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], realRoot);
        // success = branch exists → conflict.
        return { ok: false, error: `preflight: branch already exists: ${branch}` };
      } catch {
        // failure = branch absent → OK.
      }
    }

    return { ok: true, plan: { repoRoot: realRoot, repoHash, taskSlug, worktreePath, branch, metaDir } };
  }

  /**
   * Create worktree (§3 — under per-repo serial queue). `git worktree add {path} -b {branch}`.
   * Existing branch conflict → explicit error (no auto suffix). plan is preflight output as-is.
   */
  async createWorktree(plan: TaskWorktreePlan): Promise<CreateResult> {
    return this.withRepoLock(plan.repoHash, async () => {
      const safeBranch = validateGitRef(plan.branch, 'branch');
      const safePath = validatePath(plan.worktreePath, 'worktreePath');

      // Existing branch conflict pre-check (explicit error — no polluting user branch namespace).
      try {
        await this.runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${safeBranch}`], plan.repoRoot);
        // success = branch exists → conflict.
        return { ok: false, error: `createWorktree: branch already exists: ${safeBranch}` };
      } catch {
        // failure = branch absent → proceed.
      }

      try {
        await this.runGit(['worktree', 'add', safePath, '-b', safeBranch], plan.repoRoot);
      } catch (err) {
        return { ok: false, error: `createWorktree: git worktree add failed: ${(err as Error).message}` };
      }
      return { ok: true, worktreePath: safePath, branch: safeBranch };
    });
  }

  /**
   * Remove worktree (§3 — dirty preserve). porcelain check on remove entry → reject removal
   * + return preserved:true (no force-delete API — J3 UX scope).
   */
  async removeWorktree(repoRoot: string, repoHash: string, worktreePath: string): Promise<RemoveResult> {
    return this.withRepoLock(repoHash, async () => {
      const safePath = validatePath(worktreePath, 'worktreePath');

      // dirty check: porcelain inside worktree. preserve if uncommitted changes exist.
      try {
        const { stdout } = await this.runGit(['status', '--porcelain'], safePath);
        if (stdout.trim().length > 0) {
          return { ok: false, error: 'removeWorktree: worktree is dirty; preserved', preserved: true };
        }
      } catch (err) {
        // status failure (missing path etc.) — conservatively preserve, do not attempt removal.
        return { ok: false, error: `removeWorktree: status check failed: ${(err as Error).message}`, preserved: true };
      }

      try {
        await this.runGit(['worktree', 'remove', safePath], repoRoot);
      } catch (err) {
        return { ok: false, error: `removeWorktree: git worktree remove failed: ${(err as Error).message}` };
      }
      return { ok: true };
    });
  }

  /**
   * Per-repoHash serial chain (§3 — index.lock contention block). Same shape as A2aTaskService.withTaskLock.
   * Guarantees in-process serialization only — cross-process concurrent add relies on git index.lock;
   * contention propagates explicit git errors (no silent success masquerade).
   */
  private withRepoLock<T>(repoHash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoChains.get(repoHash) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.repoChains.set(
      repoHash,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
