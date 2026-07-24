/**
 * TaskPrService — J3 §2 D2. One-click PR for task deliverables (main-side orchestration).
 *
 * gh four-gate flow (§2):
 *   ① `gh --version` + `gh auth status` — version ≠ auth (G3). Missing/unauthenticated
 *      returns guidance + browser fallback reason (no throw).
 *   ② dirty check — uncommitted changes block with "not included in PR" + commit guidance (CX7).
 *   ③ `git push -u origin {branch}` — execFile argv (no shell assembly — contract G6).
 *   ④ `gh pr create --head {branch} --title --body --base {base}` — explicit --base
 *      (CL4: avoid base inference failure. base = repo default via
 *      `gh repo view --json defaultBranchRef`).
 *
 * Idempotent re-entry (CX5+G4): on pr create failure, query `gh pr list --head {branch}` —
 * existing PR converges to success via recovered URL. push "already exists" is harmless
 * when fast-forward. half-done (push only) state converges on re-click.
 *
 * On success: commit prUrl via daemon task.mission.update + PrStatusCache.invalidate to
 * close the 5-minute TTL gap (CX8).
 *
 * fork workflow (§7·CL9): missing origin remote is an explicit error (no auto-guess).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKTASK_PR_URL_RE } from '../../shared/workTask';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 60_000;

/** gh env that never blocks interactively (login prompt·pager suppressed). */
const GH_ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };

/** Minimal daemon RPC surface (prUrl commit — injectable in tests). */
export interface PrDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Minimal PrStatusCache invalidation surface (injectable in tests). */
export interface PrCachePort {
  invalidate(cwd: string, branch: string): void;
}

/** Minimal exec surface (injectable in tests). {stdout,stderr} or throw (non-zero exit). */
export type PrExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface TaskPrServiceOptions {
  daemon: PrDaemonPort;
  cache?: PrCachePort;
  exec?: PrExec;
}

export interface CreatePrInput {
  taskId: string;
  verifiedWorkspaceId: string;
  worktreePath: string;
  branch: string;
  /** PR title (task title). */
  title: string;
  /** PR body (optional — default one auto line). */
  body?: string;
}

export type CreatePrResult =
  | {
      ok: true;
      prUrl: string;
      /** Converged via recovered existing PR URL after pr create failure (idempotent re-entry). */
      recovered?: boolean;
      /** prUrl daemon commit failed (non-fatal — PR itself succeeded). */
      commitPending?: boolean;
    }
  | {
      ok: false;
      reason: 'gh-missing' | 'gh-unauth' | 'dirty' | 'no-origin' | 'push-failed' | 'pr-failed' | 'error';
      error: string;
      /** Browser fallback guidance (when gh missing/unauthenticated). */
      browseFallback?: string;
    };

export class TaskPrService {
  private readonly daemon: PrDaemonPort;
  private readonly cache: PrCachePort | undefined;
  private readonly exec: PrExec;

  constructor(opts: TaskPrServiceOptions) {
    this.daemon = opts.daemon;
    this.cache = opts.cache;
    this.exec = opts.exec ?? (execFileAsync as unknown as PrExec);
  }

  private gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      env: GH_ENV,
      windowsHide: true,
    });
  }

  private git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: process.env,
      windowsHide: true,
    });
  }

  async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    const { taskId, verifiedWorkspaceId, worktreePath, branch, title } = input;
    const body = input.body && input.body.length > 0 ? input.body : `fmux fan-out task: ${title}`;

    // ── ① gh gate: version + auth (G3 — version ≠ auth) ──
    try {
      await this.gh(['--version'], worktreePath);
    } catch {
      return {
        ok: false,
        reason: 'gh-missing',
        error: 'GitHub CLI (gh) is not installed',
        browseFallback: `Create the PR in your browser: push branch ${branch}, then use GitHub compare`,
      };
    }
    try {
      await this.gh(['auth', 'status'], worktreePath);
    } catch {
      return {
        ok: false,
        reason: 'gh-unauth',
        error: 'GitHub CLI is not authenticated — run `gh auth login` and try again',
        browseFallback: `Or create a PR for branch ${branch} directly in your browser`,
      };
    }

    // ── ② dirty check (CX7): uncommitted changes are not in PR → block + commit guidance ──
    try {
      const { stdout } = await this.git(['status', '--porcelain'], worktreePath);
      if (stdout.trim().length > 0) {
        return {
          ok: false,
          reason: 'dirty',
          error: 'Uncommitted changes — uncommitted output is not included in the PR. Commit first',
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git status failed: ${errMsg(err)}` };
    }

    // Verify origin remote exists (no auto-guess for fork/multi-remote — §7·CL9).
    try {
      const { stdout } = await this.git(['remote'], worktreePath);
      const remotes = stdout.split('\n').map((r) => r.trim()).filter(Boolean);
      if (!remotes.includes('origin')) {
        return {
          ok: false,
          reason: 'no-origin',
          error: `No origin remote (remotes: ${remotes.join(', ') || 'none'}) — head inference is not auto-guessed. Configure origin`,
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git remote lookup failed: ${errMsg(err)}` };
    }

    // ── ③ push -u origin -- {branch} (execFile argv + `--` separator — F6: block branch
    // names mistaken as options). Already exists (fast-forward) passes harmlessly.
    try {
      await this.git(['push', '-u', 'origin', '--', branch], worktreePath);
    } catch (err) {
      return { ok: false, reason: 'push-failed', error: `git push failed: ${errMsg(err)}` };
    }

    // base = repo default (CL4·[J2 contrast]4 — fan-out source branch not recorded, query default).
    // F6: on lookup failure/empty, explicit error instead of guessing 'main' (avoid wrong-base PR).
    let base: string;
    try {
      const { stdout } = await this.gh(
        ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
        worktreePath,
      );
      base = stdout.trim();
    } catch (err) {
      return { ok: false, reason: 'pr-failed', error: `Cannot determine base branch (repo default): ${errMsg(err)}` };
    }
    if (!base) {
      return { ok: false, reason: 'pr-failed', error: 'Cannot determine base branch (repo default, empty response) — origin has no defaultBranchRef' };
    }

    // ── ④ gh pr create --head --title --body --base ──
    let prUrl = '';
    try {
      const { stdout } = await this.gh(
        ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body],
        worktreePath,
      );
      prUrl = extractPrUrl(stdout);
    } catch (createErr) {
      // Idempotent re-entry (CX5+G4): query existing PR and converge via recovered URL.
      const recovered = await this.recoverExistingPr(worktreePath, branch);
      if (recovered) {
        return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, recovered, true);
      }
      return { ok: false, reason: 'pr-failed', error: `gh pr create failed: ${errMsg(createErr)}` };
    }

    if (!prUrl || !WORKTASK_PR_URL_RE.test(prUrl)) {
      // Output parse failed — try re-entry lookup to recover URL.
      const recovered = await this.recoverExistingPr(worktreePath, branch);
      if (recovered) {
        return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, recovered, true);
      }
      return {
        ok: false,
        reason: 'pr-failed',
        error: `PR was created but URL could not be parsed: ${prUrl || '(empty output)'}`,
      };
    }

    return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, prUrl, false);
  }

  /** Look up existing PR URL (idempotent re-entry). null if none. */
  private async recoverExistingPr(worktreePath: string, branch: string): Promise<string | null> {
    try {
      const { stdout } = await this.gh(
        ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url'],
        worktreePath,
      );
      const url = stdout.trim();
      return url.length > 0 && WORKTASK_PR_URL_RE.test(url) ? url : null;
    } catch {
      return null;
    }
  }

  /** Commit prUrl (daemon) + PrStatusCache invalidate. Commit failure is non-fatal (commitPending). */
  private async finalize(
    taskId: string,
    verifiedWorkspaceId: string,
    worktreePath: string,
    branch: string,
    prUrl: string,
    recovered: boolean,
  ): Promise<CreatePrResult> {
    let commitPending = false;
    try {
      const res = (await this.daemon.rpc('task.mission.update', {
        taskId,
        verifiedWorkspaceId,
        prUrl,
      })) as { ok?: boolean };
      if (!res || res.ok !== true) commitPending = true;
    } catch {
      commitPending = true;
    }
    // CX8: PR created → invalidate 5-minute TTL cache (next poll reflects new PR state immediately).
    try {
      this.cache?.invalidate(worktreePath, branch);
    } catch {
      /* Cache invalidation failure is harmless — next TTL expiry converges */
    }
    return {
      ok: true,
      prUrl,
      ...(recovered ? { recovered: true } : {}),
      ...(commitPending ? { commitPending: true } : {}),
    };
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const withStderr = err as Error & { stderr?: string };
    const stderr = typeof withStderr.stderr === 'string' ? withStderr.stderr.trim() : '';
    return stderr.length > 0 ? stderr.slice(0, 300) : err.message;
  }
  return String(err);
}

/** Extract PR URL from gh pr create stdout (last github pull URL line). */
function extractPrUrl(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    if (m) return m[0];
  }
  return '';
}
