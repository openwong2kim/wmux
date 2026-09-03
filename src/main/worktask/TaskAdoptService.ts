// ─── TaskAdoptService — take a task's whole result into the parent checkout ───
//
// The GUI already has an adopt path: read a task worktree's diff, tick the hunks
// you want, apply them into the parent. That is a HUMAN loop — it exists so a
// person can take three of five files. An orchestrator brain does not select
// hunks; it decides "this task's work is good, land it", and the only thing it
// was missing was a task-level verb for that. So hunk selection stays in the
// GUI and this service is the all-or-nothing sibling of it.
//
// Guarantees, all of them argv (no shell, no caller string ever reaches git):
//   - The target is DERIVED — the parent repository of the task's own worktree,
//     never a path the caller names.
//   - The target must be clean. Applying a patch on top of uncommitted work
//     mixes two authors' edits into one unreviewable pile, and `git apply` gives
//     no way back once it half-succeeds.
//   - The patch is taken against the parent's CURRENT HEAD, so what lands is
//     exactly the difference between what the parent has and what the task
//     produced — committed and uncommitted alike.
//   - Applied with --3way and left UNSTAGED: adopting is not committing. The
//     human (or the brain, with a commit of its own) still decides.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { git as runGit, type GitResult } from '../git/git';

/** Injectable git (same seam shape as TaskPrService.exec). */
export type AdoptGit = (args: string[], cwd: string) => Promise<GitResult>;

export interface TaskAdoptServiceOptions {
  git?: AdoptGit;
  /** Injected for tests; defaults to a temp file under os.tmpdir(). */
  writePatch?: (patch: string) => string;
  removePatch?: (file: string) => void;
}

export interface AdoptTaskInput {
  taskId: string;
  worktreePath: string;
}

export type AdoptTaskResult =
  | {
      ok: true;
      taskId: string;
      /** Repository the changes landed in. */
      targetRepo: string;
      /** Paths the patch touched, as git reported them. */
      files: string[];
    }
  | {
      ok: false;
      taskId: string;
      reason: 'no-repo' | 'not-a-task-worktree' | 'dirty-target' | 'empty' | 'apply-failed' | 'error';
      error: string;
    };

export class TaskAdoptService {
  private readonly git: AdoptGit;
  private readonly writePatch: (patch: string) => string;
  private readonly removePatch: (file: string) => void;

  constructor(opts: TaskAdoptServiceOptions = {}) {
    this.git = opts.git ?? runGit;
    this.writePatch =
      opts.writePatch ??
      ((patch) => {
        const file = path.join(os.tmpdir(), `wmux-adopt-${crypto.randomBytes(8).toString('hex')}.patch`);
        fs.writeFileSync(file, patch, 'utf8');
        return file;
      });
    this.removePatch =
      opts.removePatch ??
      ((file) => {
        try {
          fs.unlinkSync(file);
        } catch {
          // Best effort — a leftover temp patch is not worth an error path.
        }
      });
  }

  async adopt(input: AdoptTaskInput): Promise<AdoptTaskResult> {
    const { taskId, worktreePath } = input;

    // ── The target, derived ──────────────────────────────────────────────
    const commonDir = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
    if (commonDir.code !== 0 || commonDir.stdout.trim().length === 0) {
      return { ok: false, taskId, reason: 'no-repo', error: 'the task worktree is not inside a git repository' };
    }
    const top = await this.git(['rev-parse', '--show-toplevel'], path.dirname(commonDir.stdout.trim()));
    const targetRepo = top.code === 0 ? top.stdout.trim() : '';
    if (!targetRepo) {
      return { ok: false, taskId, reason: 'no-repo', error: "the task worktree's parent repository could not be resolved" };
    }
    if (path.resolve(targetRepo) === path.resolve(worktreePath)) {
      // The task is the main checkout, not a worktree of it — there is nothing
      // to adopt INTO, and applying a repo's own diff onto itself is a no-op at
      // best and a corruption at worst.
      return {
        ok: false,
        taskId,
        reason: 'not-a-task-worktree',
        error: 'this task runs in the main checkout, not in a worktree of it, so there is no parent to adopt into',
      };
    }

    // ── The target must be clean ─────────────────────────────────────────
    const status = await this.git(['status', '--porcelain'], targetRepo);
    if (status.code !== 0) {
      return { ok: false, taskId, reason: 'error', error: `git status failed in ${targetRepo}: ${status.stderr.trim()}` };
    }
    if (status.stdout.trim().length > 0) {
      return {
        ok: false,
        taskId,
        reason: 'dirty-target',
        error:
          `${targetRepo} has uncommitted changes; adopting on top of them would mix two authors' edits ` +
          'into one unreviewable state. Commit or stash there first.',
      };
    }

    const head = await this.git(['rev-parse', 'HEAD'], targetRepo);
    const base = head.code === 0 ? head.stdout.trim() : '';
    if (!base) {
      return { ok: false, taskId, reason: 'error', error: `${targetRepo} has no HEAD commit to adopt against` };
    }

    // ── The patch ────────────────────────────────────────────────────────
    // `add -N` so files the task CREATED are in the diff at all. It touches the
    // task's index and nothing else — no content is staged, and the task's own
    // commits are unaffected.
    await this.git(['add', '-A', '-N'], worktreePath);
    const diff = await this.git(['diff', '--binary', base], worktreePath);
    if (diff.code !== 0) {
      return { ok: false, taskId, reason: 'error', error: `git diff failed in the task worktree: ${diff.stderr.trim()}` };
    }
    if (diff.stdout.trim().length === 0) {
      return {
        ok: false,
        taskId,
        reason: 'empty',
        error: 'this task has produced no changes against the parent repository, so there is nothing to adopt',
      };
    }
    const names = await this.git(['diff', '--name-only', base], worktreePath);
    const files = names.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    // ── Apply, unstaged ──────────────────────────────────────────────────
    const patchFile = this.writePatch(diff.stdout);
    try {
      const applied = await this.git(['apply', '--3way', '--whitespace=nowarn', patchFile], targetRepo);
      if (applied.code !== 0) {
        return {
          ok: false,
          taskId,
          reason: 'apply-failed',
          error: `the task's changes did not apply cleanly to ${targetRepo}: ${applied.stderr.trim()}`,
        };
      }
    } finally {
      this.removePatch(patchFile);
    }

    return { ok: true, taskId, targetRepo, files };
  }
}
