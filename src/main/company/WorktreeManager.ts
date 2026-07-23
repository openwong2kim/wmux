import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { WorktreeInfo } from '../../shared/types';
import { getGitExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/**
 * Validates a git ref name (branch name) to prevent flag injection
 * and reject obviously invalid values.
 * See `git check-ref-format` rules.
 */
function validateGitRef(ref: string, label: string): string {
  if (!ref || ref.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const trimmed = ref.trim();
  // Reject values starting with '-' which could be interpreted as flags
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`);
  }
  // Reject path traversal
  if (trimmed.includes('..')) {
    throw new Error(`${label} must not contain '..'`);
  }
  // Reject control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  // Enforce reasonable length
  if (trimmed.length > 200) {
    throw new Error(`${label} is too long (max 200 characters)`);
  }
  return trimmed;
}

/**
 * Validates a filesystem path for use as a git worktree path.
 */
function validatePath(p: string, label: string): string {
  if (!p || p.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const trimmed = p.trim();
  // Reject values starting with '-'
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return path.resolve(trimmed);
}

/**
 * Manager that provides per-department isolated workspaces using git worktrees.
 * All git commands run relative to cwd (current working directory).
 */
export class WorktreeManager {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = validatePath(cwd, 'cwd');
  }

  /**
   * Create a new worktree.
   * Runs `git worktree add <path> -b <branch>`.
   */
  async createWorktree(branch: string, worktreePath: string): Promise<void> {
    const safeBranch = validateGitRef(branch, 'branch');
    const safePath = validatePath(worktreePath, 'worktreePath');
    await execFileAsync('git', ['worktree', 'add', safePath, '-b', safeBranch], {
      cwd: this.cwd,
      timeout: 30000,
      env: getGitExecEnv(),
    });
  }

  /**
   * Remove a worktree.
   * Runs `git worktree remove <path>`.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    const safePath = validatePath(worktreePath, 'worktreePath');
    await execFileAsync('git', ['worktree', 'remove', safePath], {
      cwd: this.cwd,
      timeout: 30000,
      env: getGitExecEnv(),
    });
  }

  /**
   * Return all worktrees.
   * Parses output of `git worktree list --porcelain`.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: this.cwd, timeout: 15000, env: getGitExecEnv() },
    );

    const results: WorktreeInfo[] = [];
    const blocks = stdout.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n').filter(Boolean);
      const info: Partial<WorktreeInfo> = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          info.worktree = line.slice('worktree '.length).trim();
        } else if (line.startsWith('HEAD ')) {
          info.HEAD = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          // refs/heads/branch-name → branch-name
          const ref = line.slice('branch '.length).trim();
          info.branch = ref.replace(/^refs\/heads\//, '');
        } else if (line === 'bare') {
          info.bare = true;
        }
      }

      if (info.worktree) {
        results.push({
          worktree: info.worktree,
          HEAD: info.HEAD ?? '',
          branch: info.branch ?? '(detached)',
          bare: info.bare,
        });
      }
    }

    return results;
  }

  /**
   * Merge the given branch into the current branch (or targetBranch).
   * Runs `git merge <branch>` and returns the result string.
   */
  async mergeWorktree(branch: string, targetBranch?: string): Promise<string> {
    const safeBranch = validateGitRef(branch, 'branch');
    if (targetBranch) {
      const safeTarget = validateGitRef(targetBranch, 'targetBranch');
      // Switch to targetBranch first, then merge
      await execFileAsync('git', ['checkout', safeTarget], { cwd: this.cwd, timeout: 30000, env: getGitExecEnv() });
    }
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['merge', safeBranch],
      { cwd: this.cwd, timeout: 60000, env: getGitExecEnv() },
    );
    return (stdout + stderr).trim();
  }
}
