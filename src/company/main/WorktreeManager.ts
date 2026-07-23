import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorktreeInfo } from '../types';

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
 * Manager providing per-department isolated workspaces via Git worktrees.
 * All git commands run relative to cwd (current working directory).
 */
export class WorktreeManager {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = validatePath(cwd, 'cwd');
  }

  /**
   * Creates a new worktree.
   * Runs `git worktree add <path> -b <branch>`.
   */
  async createWorktree(branch: string, worktreePath: string): Promise<void> {
    const safeBranch = validateGitRef(branch, 'branch');
    const safePath = validatePath(worktreePath, 'worktreePath');
    await execFileAsync('git', ['worktree', 'add', safePath, '-b', safeBranch], {
      cwd: this.cwd,
      timeout: 30000,
    });
  }

  /**
   * Removes a worktree.
   * Runs `git worktree remove <path>`.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    const safePath = validatePath(worktreePath, 'worktreePath');
    await execFileAsync('git', ['worktree', 'remove', safePath], {
      cwd: this.cwd,
      timeout: 30000,
    });
  }

  /**
   * Returns all worktrees.
   * Parses output of `git worktree list --porcelain`.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: this.cwd, timeout: 15000 },
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
   * Merges the specified branch into the current branch (or targetBranch).
   * Runs `git merge <branch>` and returns the result string.
   */
  async mergeWorktree(branch: string, targetBranch?: string): Promise<string> {
    const safeBranch = validateGitRef(branch, 'branch');
    if (targetBranch) {
      const safeTarget = validateGitRef(targetBranch, 'targetBranch');
      // Switch to targetBranch first, then merge
      await execFileAsync('git', ['checkout', safeTarget], { cwd: this.cwd, timeout: 30000 });
    }
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['merge', safeBranch],
      { cwd: this.cwd, timeout: 60000 },
    );
    return (stdout + stderr).trim();
  }

  /**
   * Resolve the actual git directory for a worktree.
   * In a worktree, `.git` is a file containing `gitdir: /path/to/real/gitdir`.
   * In a regular repo, `.git` is the directory itself.
   */
  private async resolveGitDir(worktreePath: string): Promise<string> {
    const gitPath = path.join(worktreePath, '.git');
    try {
      const stat = await fs.promises.stat(gitPath);
      if (stat.isFile()) {
        const content = await fs.promises.readFile(gitPath, 'utf-8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const resolved = match[1].trim();
          return path.isAbsolute(resolved)
            ? resolved
            : path.resolve(worktreePath, resolved);
        }
      }
      return gitPath;
    } catch {
      return gitPath;
    }
  }

  /**
   * Install a pre-commit hook in a worktree that rejects changes to files
   * outside the owned scope.
   */
  async installScopeHook(worktreePath: string, ownedFiles: string[]): Promise<void> {
    const safePath = validatePath(worktreePath, 'worktreePath');
    if (ownedFiles.length === 0) {
      throw new Error('ownedFiles must not be empty');
    }

    const escapedFiles = ownedFiles.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const ownedPattern = escapedFiles.join('|');
    // Use single quotes to prevent shell injection — escape any embedded single quotes
    const safePattern = ownedPattern.replace(/'/g, "'\\''");

    const hookContent = `#!/bin/sh
# Auto-generated by wmux WorkUnit scope enforcement
OWNED_FILES='${safePattern}'
STAGED=$(git diff --cached --name-only)
if [ -z "$STAGED" ]; then
  exit 0
fi
BLOCKED=""
for file in $STAGED; do
  if ! echo "$file" | grep -qE "^($OWNED_FILES)$"; then
    BLOCKED="$BLOCKED\\n  $file"
  fi
done
if [ -n "$BLOCKED" ]; then
  echo "[wmux] BLOCKED: The following files are outside your owned scope:"
  echo -e "$BLOCKED"
  echo "[wmux] Owned files pattern: $OWNED_FILES"
  exit 1
fi
exit 0
`;

    const gitDir = await this.resolveGitDir(safePath);
    const targetHooksDir = path.join(gitDir, 'hooks');
    await fs.promises.mkdir(targetHooksDir, { recursive: true });
    const hookPath = path.join(targetHooksDir, 'pre-commit');
    await fs.promises.writeFile(hookPath, hookContent, { mode: 0o755 });
  }

  /**
   * Validate that a worktree's uncommitted changes are within the allowed scope.
   * Returns a list of file paths that violate the scope (empty if clean).
   */
  async validateWorkUnitScope(worktreePath: string, ownedFiles: string[]): Promise<string[]> {
    const safePath = validatePath(worktreePath, 'worktreePath');
    const parseViolations = (stdout: string): string[] => {
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const changedFiles = trimmed.split('\n').filter(Boolean);
      const ownedSet = new Set(ownedFiles);
      return changedFiles.filter((f) => !ownedSet.has(f));
    };

    try {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: safePath,
        timeout: 15000,
      });
      return parseViolations(stdout);
    } catch {
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--cached'], {
          cwd: safePath,
          timeout: 15000,
        });
        return parseViolations(stdout);
      } catch {
        return [];
      }
    }
  }
}
