// "Continue on another account" for a WSL pane: the transcript copy runs
// inside the pane's distro, as the pane's own user (WSL_ACCOUNT_COPY_SH), so
// the target account's home is made and owned exactly as a pane spawn makes
// it. A write through the \\wsl$ share would be owned by the distro's default
// user and would create the home before the account script could.
//
// Never boots a VM: `wsl.exe -d <distro>` starts a stopped distro, so the run
// is skipped unless the pane's own wsl.exe is still alive (the same gate the
// WSL agent probes use, wslAgentProcess.ts).

import { execFile } from 'child_process';
import os from 'os';
import { mergeWslEnv, wslTargetArgs, type WslTarget } from '../shared/wsl';
import { decodeWslOutput } from '../shared/wslDistro';
import { WSL_ACCOUNT_COPY_EXIT, WSL_ACCOUNT_COPY_SH } from '../shared/wslIntegration';
import { windowsPidAlive } from './wslAgentProcess';

export interface WslAccountCopyRequest {
  /** The pane's Windows `wsl.exe` (session meta `cmd`). */
  shell: string;
  target: WslTarget;
  /** The pane's wsl.exe pid: the never-boot-a-VM gate. */
  hostPid: number;
  /** The target account's home key (wslAccountHomeKey). */
  key: string;
  share: boolean;
  /** The pane's WMUX_DATA_SUFFIX. */
  suffix: string;
  /** The Windows path of the account script (ensureWslAccountScript). */
  accountScript: string;
  /** The source transcript's Linux path. */
  source: string;
  project: string;
  sessionId: string;
}

export type WslAccountCopyOutcome =
  | { result: 'copied' | 'same' | 'diverged'; home: string }
  | { result: 'failed'; reason: string };

type Run = (shell: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;

const COPY_TIMEOUT_MS = 30_000;

const run: Run = (shell, args, env) => new Promise((resolve, reject) => {
  execFile(shell, args, {
    encoding: 'buffer', timeout: COPY_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true, cwd: os.homedir(), env,
  }, (error, stdout, stderr) => {
    const code = (error as (Error & { code?: unknown }) | null)?.code;
    // A timeout or a missing wsl.exe has no numeric exit code.
    if (error && typeof code !== 'number') { reject(error); return; }
    resolve({ code: typeof code === 'number' ? code : 0, stdout: stdout.toString('utf8'), stderr: decodeWslOutput(stderr) });
  });
});

/** The bash arguments after `-c`, in WSL_ACCOUNT_COPY_SH's order. Exported for tests. */
export function wslAccountCopyArgs(req: Pick<WslAccountCopyRequest, 'key' | 'share' | 'suffix' | 'source' | 'project' | 'sessionId'>): string[] {
  return ['wmux-copy', req.key, req.share ? '1' : '0', req.suffix, req.source, req.project, req.sessionId];
}

/** What the script's exit code and first output line mean. Exported for tests. */
export function parseWslAccountCopy(code: number, stdout: string, stderr = ''): WslAccountCopyOutcome {
  const home = stdout.split('\n')[0]?.trim() ?? '';
  const result = code === WSL_ACCOUNT_COPY_EXIT.copied ? 'copied'
    : code === WSL_ACCOUNT_COPY_EXIT.same ? 'same'
      : code === WSL_ACCOUNT_COPY_EXIT.diverged ? 'diverged' : null;
  if (!result) return { result: 'failed', reason: stderr.trim() || `exit ${code}` };
  if (!home.startsWith('/')) return { result: 'failed', reason: 'no account home reported' };
  return { result, home };
}

export async function runWslAccountCopy(
  req: WslAccountCopyRequest,
  deps: { run?: Run; hostAlive?: (pid: number) => boolean } = {},
): Promise<WslAccountCopyOutcome> {
  if (!(deps.hostAlive ?? windowsPidAlive)(req.hostPid)) return { result: 'failed', reason: 'the pane\'s wsl.exe is gone' };
  const args = [...wslTargetArgs(req.target), '--exec', '/bin/bash', '--noprofile', '--norc', '-c', WSL_ACCOUNT_COPY_SH, ...wslAccountCopyArgs(req)];
  // Only the script's path crosses by name (translated to Linux by WSLENV /p); every other value is an argument.
  const env = { ...process.env, WSL_UTF8: '1', WMUX_WSL_ACCOUNT_SH: req.accountScript, WSLENV: mergeWslEnv(process.env.WSLENV, ['WMUX_WSL_ACCOUNT_SH/p']) };
  try {
    const { code, stdout, stderr } = await (deps.run ?? run)(req.shell, args, env);
    return parseWslAccountCopy(code, stdout, stderr);
  } catch (err) {
    return { result: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
