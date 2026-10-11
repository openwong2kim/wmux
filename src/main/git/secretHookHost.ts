// Where the app installs its pre-commit secret check (main/git/secretHook.ts):
// the repository shown on the Git page, and the repository behind every Moa /
// fan-out task worktree. Best-effort: a failed install never blocks anything.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import { getExecEnv } from '../../shared/execEnv';
import { SecretHookInstaller, type SecretHookRuntime } from './secretHook';

function runtime(): SecretHookRuntime | null {
  try {
    const cli = app.isPackaged
      ? path.join(process.resourcesPath, 'cli-bundle', 'index.js')
      : path.join(app.getAppPath(), 'dist', 'cli-bundle', 'index.js');
    return { runtime: process.execPath, cli };
  } catch {
    return null;
  }
}

export const secretHooks = new SecretHookInstaller(runtime, {
  git: (args, cwd) => new Promise((resolve) => {
    execFile('git', args, { cwd, env: getExecEnv(), timeout: 15_000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  }),
});

/** Fire-and-forget install for the repository at `cwd`. */
export function ensureSecretHook(cwd: string): void {
  void secretHooks.ensure(cwd)?.catch(() => undefined);
}
