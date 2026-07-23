// Shared git exec helper — promoted from diff.handler (J2) git() (behavior unchanged).
// Fixed cwd, timeout and buffer caps. Returns stdout/stderr/code instead of throw:
// callers must be able to downgrade git failures to display errors (fail-soft surface),
// so execFile throws are absorbed here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: getGitExecEnv(),
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
}
