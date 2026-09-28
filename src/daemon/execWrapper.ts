/**
 * X8 exec-style pane: build the wrapper-shell argv that runs `command` as
 * the pane's ROOT process (systemd ExecStart semantics) instead of typing
 * it into an interactive shell. Process = unit: when the command exits the
 * PTY exits, so `session:died` carries the command's own exit code and a
 * recovery/restart replay re-launches the command itself — without this an
 * agent loop crash is invisible (the parent shell survives) and a reboot
 * revives an empty shell instead of the loop.
 *
 * The wrapper shell binary is wmux's choice (the session's resolved shell),
 * NOT part of the trust surface — the trust-approved bytes are `command`.
 *
 * Exit-code propagation per family:
 *  - pwsh/powershell: `-Command "<cmd>; <snapshot tail>"`. pwsh's own exit
 *    code only reflects script success/failure, so propagate explicitly.
 *    The tail snapshots `$?` and `$LASTEXITCODE` FIRST (any later expression
 *    resets `$?` — same trap the OSC 133 prompt hook documents) and then:
 *    native command ran → its code; pure-PS success → 0; pure-PS failure →
 *    1. The third arm is load-bearing: a missing binary is a NON-terminating
 *    CommandNotFound, so a bare `exit $LASTEXITCODE` would exit 0 and
 *    `restart: on-failure` would misread a typo'd command as success
 *    (measured 2026-06-13). A terminating script error still makes pwsh
 *    exit 1 before the tail runs. `-NoProfile` keeps the unit start lean
 *    (PATH on Windows comes from the process env, not the profile, so
 *    command resolution is unaffected).
 *  - cmd: `/d /s /c <cmd>` propagates the child's exit code natively and
 *    `/d` skips AutoRun hooks.
 *  - POSIX shells (bash/zsh/sh/dash/ksh/fish): `-lc <cmd>` — the shell
 *    exits with the last command's status natively; `-l` loads the login
 *    profile so PATH additions (npm shims like `claude`) resolve.
 *
 * Returns null for an unrecognized family — the caller must swap the
 * wrapper to a known-good platform shell and retry, never guess argv.
 */
/**
 * Snapshot-first exit propagation (see the family table above). Exported
 * for tests; the wmux-prefixed variable names keep the tail from colliding
 * with anything the user command defines.
 */
export const PWSH_EXIT_TAIL =
  '; $__wmuxOk = $?; $__wmuxLec = $LASTEXITCODE;' +
  ' if ($null -ne $__wmuxLec) { exit $__wmuxLec } elseif ($__wmuxOk) { exit 0 } else { exit 1 }';

/**
 * `pwshPolicyArgs` is inserted before `-Command` for the pwsh/powershell
 * family only (see src/shared/pwshExecutionPolicy.ts, #1620). The caller
 * decides it so this stays a pure argv builder.
 */
export function buildExecArgs(shellPath: string, command: string, pwshPolicyArgs: readonly string[] = []): string[] | null {
  // Split on BOTH path separators so a Windows shell path (C:\…\pwsh.exe) is
  // classified by its family even when this daemon runs on POSIX, where
  // path.basename would keep the backslashes and miss the stem. The shell
  // FAMILY is what selects the wrapper argv — never the host filesystem.
  const stem = (shellPath.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/^-/, '') // login shells show up as '-zsh'
    .replace(/\.exe$/, '');

  if (stem === 'pwsh' || stem === 'powershell') {
    return ['-NoLogo', '-NoProfile', ...pwshPolicyArgs, '-Command', `${command}${PWSH_EXIT_TAIL}`];
  }
  if (stem === 'cmd') {
    return ['/d', '/s', '/c', command];
  }
  if (
    stem === 'bash' ||
    stem === 'zsh' ||
    stem === 'sh' ||
    stem === 'dash' ||
    stem === 'ksh' ||
    stem === 'fish'
  ) {
    return ['-lc', command];
  }
  return null;
}
