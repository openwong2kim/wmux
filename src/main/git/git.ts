// Shared git exec helper — promoted from diff.handler (J2) git() (behavior unchanged).
// Fixed cwd, timeout and buffer caps. Returns stdout/stderr/code instead of throw:
// callers must be able to downgrade git failures to display errors (fail-soft surface),
// so execFile throws are absorbed here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitExecEnv } from '../../shared/execEnv';
import {
  hostCommandTarget,
  preparePaneCommand,
  type PaneCommandTarget,
} from './paneCommand';

const execFileAsync = promisify(execFile);

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export function prepareGitCommand(args: string[], input: PaneCommandTarget | string) {
  const target = typeof input === 'string' ? hostCommandTarget(input) : input;
  return preparePaneCommand(target, 'git', args);
}

export async function git(args: string[], input: PaneCommandTarget | string): Promise<GitResult> {
  try {
    const command = prepareGitCommand(args, input);
    if (!command.ok) {
      return { stdout: '', stderr: command.error, code: 1 };
    }
    const { stdout, stderr } = await execFileAsync(command.file, command.args, {
      ...(command.cwd ? { cwd: command.cwd } : {}),
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

type GitRunner = (
  args: string[],
  input: PaneCommandTarget | string,
) => Promise<GitResult>;

/** Resolve a path or live pane target to its current checkout/worktree root. */
export async function resolveGitToplevel(
  input: PaneCommandTarget | string,
  run: GitRunner = git,
): Promise<string | null> {
  const result = await run(['rev-parse', '--show-toplevel'], input);
  const toplevel = result.code === 0 ? result.stdout.trim() : '';
  return toplevel || null;
}
