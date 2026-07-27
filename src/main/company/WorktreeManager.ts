import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { WorktreeInfo } from '../../shared/types';
import { getExecEnv } from '../../shared/execEnv';

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
 * Git worktree를 사용하여 부서별 독립 작업 환경을 제공하는 매니저.
 * 모든 git 명령은 cwd(현재 작업 디렉토리)를 기준으로 실행한다.
 */
export class WorktreeManager {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = validatePath(cwd, 'cwd');
  }

  /**
   * 새 worktree를 생성한다.
   * `git worktree add <path> -b <branch>` 실행.
   */
  async createWorktree(branch: string, worktreePath: string): Promise<void> {
    const safeBranch = validateGitRef(branch, 'branch');
    const safePath = validatePath(worktreePath, 'worktreePath');
    await execFileAsync('git', ['worktree', 'add', safePath, '-b', safeBranch], {
      cwd: this.cwd,
      timeout: 30000,
      env: getExecEnv(),
    });
  }

  /**
   * worktree를 제거한다.
   * `git worktree remove <path>` 실행.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    const safePath = validatePath(worktreePath, 'worktreePath');
    await execFileAsync('git', ['worktree', 'remove', safePath], {
      cwd: this.cwd,
      timeout: 30000,
      env: getExecEnv(),
    });
  }

  /**
   * 모든 worktree 목록을 반환한다.
   * `git worktree list --porcelain` 출력을 파싱한다.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: this.cwd, timeout: 15000, env: getExecEnv() },
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
   * 지정된 브랜치를 현재 브랜치(또는 targetBranch)에 merge한다.
   * `git merge <branch>` 실행 후 결과 문자열을 반환한다.
   */
  async mergeWorktree(branch: string, targetBranch?: string): Promise<string> {
    const safeBranch = validateGitRef(branch, 'branch');
    if (targetBranch) {
      const safeTarget = validateGitRef(targetBranch, 'targetBranch');
      // targetBranch로 먼저 전환한 뒤 merge
      await execFileAsync('git', ['checkout', safeTarget], { cwd: this.cwd, timeout: 30000, env: getExecEnv() });
    }
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['merge', safeBranch],
      { cwd: this.cwd, timeout: 60000, env: getExecEnv() },
    );
    return (stdout + stderr).trim();
  }
}
