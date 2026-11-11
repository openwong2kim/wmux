/**
 * How a Squirrel install hook relaunches the app without keeping the
 * installer waiting (#3280).
 *
 * Squirrel starts each hook with stdout and stderr redirected to pipes, and
 * reads them to the end after the hook exits. libuv starts every child with
 * `bInheritHandles=TRUE`, so a process the hook spawns directly inherits the
 * hook's inheritable handles, those pipe ends included, whatever `stdio` it
 * is given. A relaunched app kept the pipe open for as long as it ran, and
 * Setup.exe, plus everything Squirrel does after the hook, waited until the
 * user closed wmux (runner probe, run 43075263739).
 *
 * So the hook relaunches through ShellExecute: a short-lived PowerShell runs
 * `Start-Process`, and the app it starts inherits nothing from us. Only that
 * PowerShell holds the pipe, for the second it runs.
 *
 * And it relaunches only when nothing else will. The in-app updater's install
 * waiter starts Setup.exe non-silently, so Squirrel's own
 * `--squirrel-firstrun` launch brings the app back; the waiter says so through
 * FIRSTRUN_RELAUNCH_ENV, which Setup.exe, Update.exe and the hook inherit. A
 * silent package-manager upgrade sets nothing, and the hook relaunches.
 */
import * as path from 'path';
import { spawn } from 'child_process';

/** Set to '1' on the Setup.exe the in-app updater starts (installTeardown.ts). */
export const FIRSTRUN_RELAUNCH_ENV = 'WMUX_SQUIRREL_FIRSTRUN_RELAUNCHES';

/** Whether the install hook relaunches the app itself. */
export function hookShouldRelaunch(env: NodeJS.ProcessEnv): boolean {
  return env[FIRSTRUN_RELAUNCH_ENV] !== '1';
}

/**
 * The PowerShell command line that starts `exe` through ShellExecute. The
 * script is passed encoded (UTF-16LE base64), so no path character can break
 * the command line; inside it the path is a single-quoted literal, where only
 * an apostrophe needs escaping (by doubling). Pure, for tests.
 */
export function relaunchCommand(exe: string, systemRoot: string): { file: string; args: string[] } {
  const script = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`;
  return {
    file: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

/** Start `exe` so it inherits no handle of this process. Best-effort, win32. */
export function relaunchWithoutInheritance(exe: string): void {
  const { file, args } = relaunchCommand(exe, process.env.SystemRoot || 'C:\\Windows');
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', (err: Error) => console.warn('[Squirrel] relaunch failed:', err))
    .unref();
}
