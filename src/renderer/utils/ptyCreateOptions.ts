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

import type { WorkspaceProfile } from '../../shared/types';

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

/**
 * Overlay a workspace profile onto PTY create options for a NEW pane.
 *
 * - Profile env is merged UNDER any caller-supplied pane env (so an explicit
 *   per-pane override wins over the workspace default).
 * - The profile's defaultPaneCommand becomes `initialCommand` only when the
 *   caller didn't already specify one (an explicit command always wins).
 *
 * Pure and side-effect-free: returns the original object untouched when there
 * is no profile, so callsites with no configured workspace stay byte-identical.
 */
export function withWorkspaceProfile<T extends PtyCreateOptions>(
  options: T,
  profile: WorkspaceProfile | undefined,
): T {
  if (!profile) return options;
  const next: T = { ...options };
  if (profile.env && Object.keys(profile.env).length > 0) {
    next.env = { ...profile.env, ...(options.env ?? {}) };
  }
  if (profile.defaultPaneCommand && next.initialCommand === undefined) {
    next.initialCommand = profile.defaultPaneCommand;
  }
  return next;
}
