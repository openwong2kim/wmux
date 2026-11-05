// Env for one launch, not for the pane: a company seat's agent starts with its
// first-run env, and a later command typed into the same shell (a second
// `claude` after the first exits) must not inherit it. Pane env would persist
// in the shell, so the env is written into the typed launch line in the pane
// shell's own syntax instead. It is applied at the write, after every stage
// that reads the line's first word (role binding, account quota, session pin,
// screen-reader flag).

import { isPlainCmdLaunchLine } from '../../shared/botWorkerGuard';
import { isCmdShellPath } from '../../shared/promptFileArgument';
import { isWslShellPath } from '../../shared/wslDistro';
import { splitModelEnvMarker } from '../../shared/workerLaunch';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Values every form below carries unquoted and unexpanded. */
const VALUE = /^[A-Za-z0-9_.-]+$/;

/** Shells that take `NAME=value command` (fish since 3.1). */
const ASSIGNMENT_SHELLS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'ash', 'busybox', 'fish',
]);
const POWERSHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell']);

type LaunchShell = 'posix' | 'powershell' | 'cmd';

function launchShellOf(shell: string): LaunchShell | null {
  if (isWslShellPath(shell)) return 'posix';
  if (isCmdShellPath(shell)) return 'cmd';
  const base = (shell.trim().split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  if (POWERSHELLS.has(base)) return 'powershell';
  return ASSIGNMENT_SHELLS.has(base) ? 'posix' : null;
}

/**
 * `line` with `env` set for the command it runs only. Returns `line` as is,
 * with a warning, when the shell has no form here or a name or value is not
 * one every form carries: the agent may then stop on its first-run screen,
 * which is the safe direction.
 */
export function withLaunchEnv(line: string, env: Record<string, string> | undefined, shell: string): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return line;
  if (entries.some(([name, value]) => !NAME.test(name) || typeof value !== 'string' || !VALUE.test(value))) {
    console.warn('[pty:create] launch env not applied: a name or value outside what the launch line carries');
    return line;
  }
  const kind = launchShellOf(shell);
  if (kind === 'posix') {
    const { marker, command } = splitModelEnvMarker(line);
    return `${marker}${entries.map(([name, value]) => `${name}=${value}`).join(' ')} ${command}`;
  }
  if (kind === 'powershell') {
    // `finally` also runs when the agent is stopped with Ctrl+C, so the shell
    // never keeps the variable.
    const set = entries.map(([name, value]) => `$env:${name}='${value}'`).join('; ');
    const unset = entries.map(([name]) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`).join('; ');
    return `try { ${set}; ${line} } finally { ${unset} }`;
  }
  if (kind === 'cmd' && isPlainCmdLaunchLine(line)) {
    // A child cmd holds the variable and ends with the agent. The carets hand
    // `&&` to that child; the line's own quoting is left as it was.
    return `cmd /c ${entries.map(([name, value]) => `set ${name}=${value}^&^&`).join(' ')} ${line}`;
  }
  console.warn(`[pty:create] launch env not applied: no per-launch form for this shell (${shell})`);
  return line;
}
