import { execFile } from 'node:child_process';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { findExecutable, notFoundError } from './exeSearch';

/**
 * Run a CLI by bare name and resolve its stdout, rejecting on a spawn error, a
 * non-zero exit, a timeout, or output past `maxBuffer`.
 *
 * Why this exists (#1619): on Windows, `execFile('codex', …)` never finds an
 * npm-installed CLI. Node does not walk PATHEXT when completing a bare name, so
 * it only ever tries `codex.exe`, while npm installs `codex.cmd` / `codex.ps1`
 * shims. The spawn fails with ENOENT and the caller reports the CLI as not
 * installed, even though `where codex` finds it. `claude` only works by luck,
 * because it ships a real `claude.exe`. Node also refuses to spawn a `.cmd`
 * without a shell, so resolving the path alone is not enough.
 *
 * cross-spawn does both: it resolves the name with PATH and PATHEXT from the
 * env it is given, and runs a `.cmd`/`.bat` shim under `cmd.exe /d /s /c` with
 * every argument escaped for cmd's metacharacters. It is already how this repo
 * launches agents (daemon/chat/agentProcess.ts) and probes opencode.cmd
 * (shared/openCodeTerminalChatIntegration.ts).
 *
 * On POSIX nothing changes: the call goes to `execFile` exactly as before, so a
 * bare name keeps resolving the way it always has there.
 */
export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  /** Windows only: wait this long for the killed tree to close before giving up. */
  killGraceMs?: number;
}

export function runCli(command: string, args: readonly string[], opts: RunCliOptions): Promise<string> {
  if (process.platform !== 'win32') {
    return new Promise((resolve, reject) => {
      execFile(command, [...args], {
        env: opts.env, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, windowsHide: true,
      }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });
  }
  return runOnWindows(command, args, opts);
}

/**
 * Plain tokens only on Windows. A .cmd shim re-parses its command line through
 * cmd.exe twice (once for `cmd /c`, once for the shim's own `%*`), and
 * cross-spawn only double-escapes shims under `node_modules\.bin`. A global npm
 * shim such as `%APPDATA%\npm\codex.cmd` therefore loses a `^` (measured), and
 * other metacharacters are one parser quirk away from being commands. Every
 * caller passes fixed tokens (`--help`, `app-server daemon start`), so refusing
 * anything else costs nothing and means this helper can never become an
 * injection path for data a later caller forgets to vet.
 */
const WINDOWS_SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:=/@+-]*$|^--?[A-Za-z0-9][A-Za-z0-9._:=/@+-]*$/;
/**
 * The command may also be an absolute Windows path (a caller that pinned the
 * binary it resolved, as #1608 does on POSIX). Backslashes and spaces are
 * fine there because cross-spawn quotes the command as a whole; the cmd
 * metacharacters are still refused.
 */
const WINDOWS_SAFE_COMMAND_PATH = /^[A-Za-z]:\\[^"%^&|<>!\r\n]*$/;

function runOnWindows(command: string, args: readonly string[], opts: RunCliOptions): Promise<string> {
  const unsafe = WINDOWS_SAFE_TOKEN.test(command) || WINDOWS_SAFE_COMMAND_PATH.test(command)
    ? args.find((token) => !WINDOWS_SAFE_TOKEN.test(token))
    : command;
  if (unsafe !== undefined) {
    return Promise.reject(new Error(`runCli: refusing a token that is not safe through a Windows .cmd shim: ${JSON.stringify(unsafe)}`));
  }
  // cross-spawn's own lookup tries the working directory before PATH, so hand
  // it an absolute path found on PATH alone (shared/exeSearch.ts).
  const resolved = findExecutable(command, { env: opts.env ?? process.env, extensions: 'pathext' });
  if (resolved === null) return Promise.reject(notFoundError(command));
  const killGraceMs = opts.killGraceMs ?? 2000;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    let failure: Error | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const child = crossSpawn(resolved, [...args], {
      env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (error) reject(error); else resolve(stdout);
    };
    // A .cmd shim runs under cmd.exe, so killing the direct child would leave
    // the real CLI (node.exe, for an npm shim) running. Kill the whole tree.
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.stdout?.destroy();
      if (child.pid) {
        // Absolute System32 path, like daemon/chat/agentProcess.ts: a
        // PATH-resolved name is influenceable, System32 is not.
        const taskkill = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      }
      // Settle once the tree is gone so a caller's retry never overlaps it,
      // but never hang if `close` does not come.
      grace = setTimeout(() => finish(error), killGraceMs);
    };

    const timer = setTimeout(() => {
      stop(Object.assign(new Error(`${command} timed out after ${opts.timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, opts.timeoutMs);

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length + chunk.length > opts.maxBuffer) {
        stop(Object.assign(new Error(`${command} output exceeded ${opts.maxBuffer} bytes`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
        return;
      }
      stdout += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (failure) { finish(failure); return; }
      finish(code === 0 ? null : Object.assign(new Error(`${command} exited with code ${code}`), { code }));
    });
  });
}
