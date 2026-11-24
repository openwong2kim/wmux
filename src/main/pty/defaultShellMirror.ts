/**
 * Main-side mirror of the renderer's Settings default shell.
 *
 * The renderer applies the setting to a pane it creates (withDefaultShell);
 * main reads this copy only to predict where a fan-out task pane will run
 * before the pane exists, so the account pool can pick an account home
 * there (pipe/handlers/fanout.rpc.ts). The prediction is never trusted:
 * the pane's create checks the shell it really got. null = not pushed yet,
 * or a legacy name that the renderer does not apply either: then main
 * predicts a native pane, as before.
 */

const LEGACY_DEFAULT_SHELL_VALUES = new Set(['powershell', 'cmd', 'gitbash', 'wsl']);

let defaultShell: string | null = null;

/** The value withDefaultShell would apply (an executable path), or null. Pure. */
export function appliedDefaultShell(value: unknown): string | null {
  if (typeof value !== 'string' || !value || LEGACY_DEFAULT_SHELL_VALUES.has(value)) return null;
  return value.includes('\\') || value.includes('/') || value.toLowerCase().endsWith('.exe') ? value : null;
}

export function setDefaultShellMirror(value: unknown): void {
  defaultShell = appliedDefaultShell(value);
}

/** The default shell a new pane with no shell of its own gets, or null. */
export function getDefaultShellMirror(): string | null {
  return defaultShell;
}
