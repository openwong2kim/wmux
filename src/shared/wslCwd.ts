/**
 * WSL starting-directory split.
 *
 * When a pane's shell is `wsl.exe` and its cwd is a Linux-style path (an
 * absolute `/…` path, a `~`-relative path, or a `\\wsl$\...` /
 * `\\wsl.localhost\...` UNC path), that cwd cannot be handed to node-pty's
 * `cwd` spawn option: ConPTY/CreateProcess resolve the working directory as a
 * Windows path, and a Linux path (or the WSL UNC form) is not one — Windows
 * cannot stat it, so the OS-level CreateProcess call itself would fail (this
 * is the same reason `validateCwd` in pty.handler.ts has to special-case it
 * rather than just letting `fs.existsSync` reject it).
 *
 * `wsl.exe` has a native flag for exactly this: `wsl.exe --cd <linuxpath>`
 * starts the WSL shell already inside `<linuxpath>`, resolved by WSL itself
 * rather than by Windows. So the fix is to keep node-pty's own `cwd` at a
 * safe Windows directory (the caller's home) and let `--cd` do the real
 * positioning after the process is already running inside WSL.
 *
 * This module is intentionally pure (only `node:path`) so it can be unit
 * tested without electron/node-pty/fs and shared verbatim between the main
 * process (PTYManager) and the daemon (DaemonSessionManager).
 *
 * (No imports beyond this doc comment — basename splitting below is done
 * with a plain regex rather than `node:path`, so this stays pure without
 * even needing `path.win32` vs `path.posix` to agree on separators.)
 */

/**
 * True when `cmd` resolves to the WSL launcher (`wsl.exe` on Windows, or a
 * bare `wsl`). Basename is taken after splitting on BOTH `/` and `\` so a
 * forward-slash path (as can arrive from a config file or RPC) still
 * resolves — `path.win32.basename` alone would not split on `/`.
 */
export function isWslShell(cmd: string): boolean {
  if (!cmd) return false;
  const segments = cmd.split(/[\\/]/);
  const basename = segments[segments.length - 1]?.toLowerCase() ?? '';
  return basename === 'wsl.exe' || basename === 'wsl';
}

/**
 * True when `p` looks like a Linux-side path rather than a Windows one:
 * an absolute `/...` path, a `~`/`~/...` home-relative path, or one of the
 * two WSL UNC forms Windows itself uses to expose the Linux filesystem
 * (`\\wsl$\...`, `\\wsl.localhost\...`). The UNC prefixes are matched
 * case-insensitively since Windows path comparisons generally are.
 */
export function isLinuxLikeCwd(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/') || p.startsWith('~')) return true;
  const lower = p.toLowerCase();
  return lower.startsWith('\\\\wsl$\\') || lower.startsWith('\\\\wsl.localhost\\');
}

/**
 * Split a resolved (shell, cwd) pair into what node-pty should actually
 * receive: a safe Windows `spawnCwd` plus any `prefixArgs` to prepend to the
 * spawn argv. Only WSL + a Linux-like cwd triggers the split; every other
 * combination passes the cwd through untouched.
 */
export function splitWslCwd(
  cmd: string,
  cwd: string | undefined,
  homeDir: string,
): { spawnCwd: string | undefined; prefixArgs: string[] } {
  if (cwd && isWslShell(cmd) && isLinuxLikeCwd(cwd)) {
    return { spawnCwd: homeDir, prefixArgs: ['--cd', cwd] };
  }
  return { spawnCwd: cwd, prefixArgs: [] };
}
