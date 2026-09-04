// ─── TaskAdoptService — take a task's whole result into the parent checkout ───
//
// The GUI already has an adopt path: read a task worktree's diff, tick the hunks
// you want, apply them into the parent. That is a HUMAN loop — it exists so a
// person can take three of five files. An orchestrator brain does not select
// hunks; it decides "this task's work is good, land it", and the only thing it
// was missing was a task-level verb for that. So hunk selection stays in the
// GUI and this service is the all-or-nothing sibling of it.
//
// Everything below is argv only — no shell, and no caller string ever reaches
// git. The four properties that took a review round to get right:
//
//   THE BASE IS THE MERGE BASE, NOT THE PARENT'S HEAD. Diffing against the
//   parent's current HEAD makes every commit the parent has and the task does
//   not appear in the patch as a REVERSAL. Adopt task 1, commit it, adopt task
//   2 — and task 1's work is silently deleted, because task 2's worktree was
//   branched before it. `merge-base` is the last commit both sides share, so
//   the patch contains the task's changes and nothing else.
//
//   THE TARGET IS NEVER LEFT HALF-APPLIED. `git apply --3way` writes files as
//   it goes and can stop in the middle with conflict markers on disk. So the
//   patch is validated with `--check` first, and if the real apply still fails
//   the touched paths are restored (`checkout` + `reset`) before returning.
//
//   WHAT LANDS IS STAGED, NEVER COMMITTED — UNLESS THE CALLER ASKS. `git apply
//   --3way` needs the index to do its merge, so the adopted changes arrive
//   staged: `git diff --cached` in the parent is exactly what was taken.
//   Nothing is pushed either way.
//
//   That default makes ONE adopt reviewable and makes the SECOND one
//   impossible: the first adopt leaves the target dirty, and the dirty-target
//   check (rightly) refuses everything after it. A brain adopting four tasks in
//   a row therefore dead-ended on task two. `commit: true` closes the loop — the
//   index already holds exactly the adopted patch, so the service commits it
//   with a message naming the task and hands back the short sha. The
//   dirty-target check is unchanged: a target dirtied by a HUMAN is still
//   refused, because that is the state the check exists for.
//
//   THE TASK'S INDEX IS NOT TOUCHED. Untracked files only appear in a diff
//   after `git add -N`, which would leave intent-to-add entries in the index of
//   a worktree an agent is still working in. The add and the diff run against a
//   TEMPORARY index (GIT_INDEX_FILE) that is deleted afterwards.
//
//   ADOPTS ARE SERIALIZED PER TARGET REPOSITORY. The clean check and the apply
//   are separated by several git invocations; two concurrent adopts would both
//   see a clean tree and the second would apply onto the first's output.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getExecEnv } from '../../shared/execEnv';
import type { GitResult } from '../git/git';

const execFileAsync = promisify(execFile);

/** Injectable git. `env` carries GIT_INDEX_FILE for the temp-index steps. */
export type AdoptGit = (
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<GitResult>;

/** Default git: argv only, cwd fixed, never throws — a non-zero exit is data
 *  the caller branches on, exactly like the shared helper. */
const defaultGit: AdoptGit = async (args, cwd, env) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...getExecEnv(), ...(env ?? {}) },
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(e),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
};

export interface TaskAdoptServiceOptions {
  git?: AdoptGit;
  /** Injected for tests; defaults to a 0600 file in a private temp directory. */
  writePatch?: (patch: string) => string;
  removePatch?: (file: string) => void;
  /** Injected for tests; defaults to mkdtemp + rm. */
  makeTempIndex?: () => { indexFile: string; cleanup: () => void };
}

export interface AdoptTaskInput {
  taskId: string;
  worktreePath: string;
  /** Commit what was applied instead of leaving it staged. Default false =
   *  the behaviour this service shipped with. Needed to adopt several tasks in
   *  sequence: without it the second adopt hits `dirty-target`. */
  commit?: boolean;
  /** The task's title, used in the commit subject. Falls back to the task id —
   *  the caller (the RPC handler) reads it from the SERVER's own projection
   *  row, so it is never caller-supplied text. */
  title?: string;
}

export type AdoptFailureReason =
  | 'no-repo'
  | 'not-a-task-worktree'
  | 'dirty-target'
  | 'empty'
  | 'needs_rebase'
  | 'conflict'
  /** The patch applied and the commit did not (a hook refused it, no author
   *  identity, an index lock). The applied paths were restored. */
  | 'commit-failed'
  | 'error';

/** Longest commit SUBJECT this service will build from a task title. Titles are
 *  server-side projection rows, not prose, but a pasted paragraph should not
 *  become a 4 KB subject line. */
export const ADOPT_SUBJECT_MAX = 120;

/** `adopt: <title> (<taskId>)`, first line only and bounded. Argv, never a
 *  shell string, so the only thing being defended against here is a subject
 *  nobody can read. */
export function adoptCommitMessage(taskId: string, title?: string): string {
  const firstLine = (title ?? '').split('\n')[0]?.trim() ?? '';
  const name = firstLine.length > 0 ? firstLine : taskId;
  const bounded = name.length > ADOPT_SUBJECT_MAX ? `${name.slice(0, ADOPT_SUBJECT_MAX - 1)}…` : name;
  return `adopt: ${bounded} (${taskId})`;
}

export type AdoptTaskResult =
  | {
      ok: true;
      taskId: string;
      /** Repository the changes landed in. */
      targetRepo: string;
      /** Paths the patch touched, as git reported them. */
      files: string[];
      /** The merge base the patch was taken against. */
      base: string;
      /** Short sha of the commit, present only when `commit: true` was asked
       *  for. Absent means the changes are staged and uncommitted. */
      commit?: string;
    }
  | {
      ok: false;
      taskId: string;
      reason: AdoptFailureReason;
      error: string;
      /** For `conflict`: the paths that could not be applied. */
      files?: string[];
    };

/** `--porcelain=v1 -z` output → entries. NUL-framed because a path may contain
 *  a newline, and `-z` also stops git quoting non-ASCII names — a line parse
 *  reported `"src/\303\251.ts"` as a path that does not exist. Rename entries
 *  are TWO records (destination first, then origin), so the origin record is
 *  consumed with the rename that owns it. */
export function parsePorcelainZ(stdout: string): { status: string; path: string }[] {
  const records = stdout.split('\0');
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || rec.length < 4) continue;
    const status = rec.slice(0, 2);
    out.push({ status, path: rec.slice(3) });
    // R/C carry their source path in the next record.
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return out;
}

export class TaskAdoptService {
  private readonly git: AdoptGit;
  private readonly writePatch: (patch: string) => string;
  private readonly removePatch: (file: string) => void;
  private readonly makeTempIndex: () => { indexFile: string; cleanup: () => void };
  /**
   * One promise chain per target repository. The clean check and the apply are
   * several git calls apart, so without this two adopts landing at once both
   * observe a clean tree and the second writes on top of the first's result —
   * and neither operator sees a conflict, because there is no conflict: the
   * patches simply merge into one unreviewable state.
   *
   * In-process only, and that is the honest scope: the GUI's own apply path and
   * a second wmux instance are not covered. It closes the window this service
   * creates (a brain adopting N tasks in a loop), not every window that exists.
   */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  constructor(opts: TaskAdoptServiceOptions = {}) {
    this.git = opts.git ?? defaultGit;
    this.writePatch =
      opts.writePatch ??
      ((patch) => {
        // Private directory + 0600: the patch is the task's entire diff, and
        // os.tmpdir() is world-readable on every platform this ships on.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-adopt-'));
        const file = path.join(dir, 'task.patch');
        fs.writeFileSync(file, patch, { mode: 0o600 });
        return file;
      });
    this.removePatch =
      opts.removePatch ??
      ((file) => {
        try {
          fs.rmSync(path.dirname(file), { recursive: true, force: true });
        } catch {
          // Best effort — a leftover temp patch is not worth an error path.
        }
      });
    this.makeTempIndex =
      opts.makeTempIndex ??
      (() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-adopt-index-'));
        return {
          indexFile: path.join(dir, 'index'),
          cleanup: () => {
            try {
              fs.rmSync(dir, { recursive: true, force: true });
            } catch {
              // Best effort.
            }
          },
        };
      });
  }

  async adopt(input: AdoptTaskInput): Promise<AdoptTaskResult> {
    const { taskId, worktreePath, commit = false, title } = input;

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

    return this.withRepoLock(targetRepo, () =>
      this.applyInto(taskId, worktreePath, targetRepo, commit, title),
    );
  }

  /** Serialize on the target repo, and never let one adopt's failure poison the
   *  chain for the next. */
  private withRepoLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(repo);
    const prior = this.repoLocks.get(key) ?? Promise.resolve();
    const run = prior.then(work, work);
    // Swallow on the CHAIN only; the returned promise still rejects normally.
    this.repoLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async applyInto(
    taskId: string,
    worktreePath: string,
    targetRepo: string,
    commit: boolean,
    title: string | undefined,
  ): Promise<AdoptTaskResult> {
    // ── The target must be clean ─────────────────────────────────────────
    const status = await this.git(['status', '--porcelain=v1', '-z'], targetRepo);
    if (status.code !== 0) {
      return { ok: false, taskId, reason: 'error', error: `git status failed in ${targetRepo}: ${status.stderr.trim()}` };
    }
    if (parsePorcelainZ(status.stdout).length > 0) {
      return {
        ok: false,
        taskId,
        reason: 'dirty-target',
        error:
          `${targetRepo} has uncommitted changes; adopting on top of them would mix two authors' edits ` +
          'into one unreviewable state. Commit or stash there first.',
      };
    }

    // ── The base: what the two sides SHARE ───────────────────────────────
    const parentHead = await this.git(['rev-parse', 'HEAD'], targetRepo);
    const taskHead = await this.git(['rev-parse', 'HEAD'], worktreePath);
    if (parentHead.code !== 0 || parentHead.stdout.trim().length === 0) {
      return { ok: false, taskId, reason: 'error', error: `${targetRepo} has no HEAD commit to adopt against` };
    }
    if (taskHead.code !== 0 || taskHead.stdout.trim().length === 0) {
      return { ok: false, taskId, reason: 'error', error: 'the task worktree has no HEAD commit' };
    }
    const mergeBase = await this.git(
      ['merge-base', parentHead.stdout.trim(), taskHead.stdout.trim()],
      targetRepo,
    );
    const base = mergeBase.code === 0 ? mergeBase.stdout.trim() : '';
    if (!base) {
      // No shared commit: the task branched from something this repository no
      // longer contains (a rewritten base, a force-push, an unrelated history).
      // Any patch we could build would delete work rather than add it.
      return {
        ok: false,
        taskId,
        reason: 'needs_rebase',
        error:
          `the task and ${targetRepo} share no common commit, so the task's changes cannot be expressed as a patch ` +
          'against this repository — rebase the task branch onto the current base and adopt again',
      };
    }

    // ── The patch, built against a TEMPORARY index ───────────────────────
    // `add -N` is what makes new files appear in a diff at all, and doing it in
    // the task's real index leaves intent-to-add entries in a worktree an agent
    // is still using (its next `git status` reads differently, and its own
    // commit picks up files it never staged).
    const temp = this.makeTempIndex();
    const env = { GIT_INDEX_FILE: temp.indexFile };
    let patch: string;
    let files: string[];
    try {
      const seed = await this.git(['read-tree', taskHead.stdout.trim()], worktreePath, env);
      if (seed.code !== 0) {
        return { ok: false, taskId, reason: 'error', error: `could not seed a temporary index: ${seed.stderr.trim()}` };
      }
      const added = await this.git(['add', '-A', '-N'], worktreePath, env);
      if (added.code !== 0) {
        return {
          ok: false,
          taskId,
          reason: 'error',
          error: `could not stage the task's new files for diffing: ${added.stderr.trim()}`,
        };
      }
      const diff = await this.git(['diff', '--binary', base], worktreePath, env);
      if (diff.code !== 0) {
        return { ok: false, taskId, reason: 'error', error: `git diff failed in the task worktree: ${diff.stderr.trim()}` };
      }
      if (diff.stdout.trim().length === 0) {
        return {
          ok: false,
          taskId,
          reason: 'empty',
          error: 'this task has produced no changes against the shared base, so there is nothing to adopt',
        };
      }
      patch = diff.stdout;
      const names = await this.git(['diff', '--name-only', '-z', base], worktreePath, env);
      files = names.stdout.split('\0').map((l) => l.trim()).filter((l) => l.length > 0);
    } finally {
      temp.cleanup();
    }

    // ── Validate, then apply, then restore on failure ────────────────────
    const patchFile = this.writePatch(patch);
    try {
      const check = await this.git(['apply', '--check', '--3way', '--whitespace=nowarn', patchFile], targetRepo);
      if (check.code !== 0) {
        // Nothing has been written yet — this is the cheap, safe refusal.
        return {
          ok: false,
          taskId,
          reason: 'conflict',
          error: `the task's changes do not apply cleanly to ${targetRepo}: ${check.stderr.trim()}`,
          files,
        };
      }
      const applied = await this.git(['apply', '--3way', '--whitespace=nowarn', patchFile], targetRepo);
      if (applied.code !== 0) {
        // --check passed and the real apply still failed, so the tree may be
        // half-written with conflict markers in it. Put the touched paths back
        // rather than handing back a repository nobody asked for.
        await this.restore(targetRepo, files);
        return {
          ok: false,
          taskId,
          reason: 'conflict',
          error:
            `the task's changes failed to apply to ${targetRepo} and the affected paths were restored: ` +
            applied.stderr.trim(),
          files,
        };
      }
    } finally {
      this.removePatch(patchFile);
    }

    if (!commit) return { ok: true, taskId, targetRepo, files, base };

    // No pathspec: the target was verified CLEAN before the apply, so the index
    // now holds the adopted patch and nothing else. A pathspec would commit the
    // working tree's version of those paths instead of the `--3way` merge git
    // just staged, which is a different (and wrong) thing to record.
    const committed = await this.git(['commit', '-m', adoptCommitMessage(taskId, title)], targetRepo);
    if (committed.code !== 0) {
      // A hook refused it, there is no author identity, the index is locked.
      // Whatever it was, leaving the patch staged is the one outcome the caller
      // did not ask for — it is the state that blocks the NEXT adopt — so put
      // the target back exactly as the apply-failure path does.
      await this.restore(targetRepo, files);
      return {
        ok: false,
        taskId,
        reason: 'commit-failed',
        error:
          `the task's changes applied to ${targetRepo} but could not be committed, and the affected paths were restored: ` +
          (committed.stderr.trim() || committed.stdout.trim()),
        files,
      };
    }
    const head = await this.git(['rev-parse', '--short', 'HEAD'], targetRepo);
    return {
      ok: true,
      taskId,
      targetRepo,
      files,
      base,
      commit: head.code === 0 ? head.stdout.trim() : '',
    };
  }

  /** Undo a half-applied patch: unstage anything `--3way` staged, then restore
   *  the working copies. Limited to the patch's own paths so unrelated state in
   *  the repository is never touched. */
  private async restore(targetRepo: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.git(['reset', '-q', '--', ...files], targetRepo);
    await this.git(['checkout', '--', ...files], targetRepo);
    // A file the patch CREATED has nothing to check out; remove the leftovers.
    await this.git(['clean', '-qfd', '--', ...files], targetRepo);
  }
}
