export interface PtyCreateOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  workspaceId?: string;
  surfaceId?: string;
  /**
   * Workspace profile env overlay. Merged into the new PTY's environment AFTER
   * the safe-inherited baseline and BEFORE wmux identity vars are forced, so a
   * profile can configure tools (CLAUDE_CONFIG_DIR, etc.) but never spoof
   * WMUX_WORKSPACE_ID / WMUX_SURFACE_ID / WMUX_SOCKET_PATH.
   */
  env?: Record<string, string>;
  /**
   * Startup command written into the new pane's shell after creation (NOT
   * spawned as the executable — preserves shell-allowlist + quoting behavior).
   */
  initialCommand?: string;
}

const LEGACY_DEFAULT_SHELL_VALUES = new Set(['powershell', 'cmd', 'gitbash', 'wsl']);

function isExecutableShellValue(shell: string | undefined): shell is string {
  if (!shell) return false;
  if (LEGACY_DEFAULT_SHELL_VALUES.has(shell)) return false;
  return shell.includes('\\') || shell.includes('/') || shell.toLowerCase().endsWith('.exe');
}

export function withDefaultShell<T extends PtyCreateOptions>(
  options: T,
  defaultShell: string | undefined,
): T & { shell?: string } {
  if (options.shell || !isExecutableShellValue(defaultShell)) return options;
  return { ...options, shell: defaultShell };
}
