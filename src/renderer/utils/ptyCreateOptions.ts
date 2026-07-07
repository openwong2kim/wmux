import type { SpawnKind } from '../../shared/spawnKind';

export interface PtyCreateOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  workspaceId?: string;
  surfaceId?: string;
  /**
   * 스폰 출처 (실행 컨텍스트 env 정책). 사용자가 UI로 직접 여는 셸 pane만
   * 'user-shell'로 스탬프해 자격증명을 투과받는다. 프로그래매틱 스폰(MCP·company
   * provisioner·project seed)은 스탬프를 생략 → main이 fail-closed로 gated 처리.
   */
  spawnKind?: SpawnKind;
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
  /**
   * X8 exec-style unit: run this command as the pane's ROOT process (daemon
   * mode only). Set by the AppLayout funnel for a supervised wmux.json leaf —
   * mutually exclusive with `initialCommand` in practice (the funnel picks one).
   */
  exec?: string;
  /**
   * X8 supervision policy. Present alongside `exec`; arms the daemon's
   * PaneSupervisor. `limit` fields are pre-filled from the SSOT defaults at the
   * funnel, so they arrive complete here.
   */
  supervision?: {
    restart: 'on-failure' | 'always';
    limit?: { burst?: number; healthyUptimeSec?: number };
    /** U-PERM: consent-gated permission-restore bit (funnel-computed). Daemon
     * mode only; forwarded through pty.create to the daemon's supervision policy. */
    restorePermissionMode?: boolean;
  };
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

/**
 * Resolve the starting directory for a NEW terminal (issues #173/#174/#175).
 *
 * Priority: split-inherited cwd (when the toggle is on) > workspace
 * profile.startupCwd > global startupDirectory setting > undefined (the spawn
 * layer falls back to os.homedir()). Every value is best-effort: main's
 * validateCwd tolerantly drops non-existent/UNC/non-directory paths, so a
 * stale seed or a typo'd setting can never fail the spawn.
 */
export function resolveStartupCwd(args: {
  splitSeed?: string;
  splitInheritsCwd: boolean;
  profile?: WorkspaceProfile;
  startupDirectory?: string;
}): string | undefined {
  if (args.splitInheritsCwd && args.splitSeed) return args.splitSeed;
  if (args.profile?.startupCwd) return args.profile.startupCwd;
  if (args.startupDirectory && args.startupDirectory.trim().length > 0) return args.startupDirectory.trim();
  return undefined;
}

/**
 * Human-readable shell label derived from an executable path
 * (e.g. `C:\\…\\pwsh.exe` → "PowerShell 7"). Used for the surface tab title
 * when a PTY is adopted. Lifted out of AppLayout so the eager-spawn path in
 * the `pane.split` RPC handler (background-workspace split, #236) produces the
 * exact same labels as the empty-leaf PTY funnel.
 */
export function shellDisplayName(shellPath: string): string {
  const base = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  if (base.includes('pwsh')) return 'PowerShell 7';
  if (base.includes('powershell')) return 'PowerShell';
  if (base.includes('bash')) return 'Bash';
  if (base.includes('wsl')) return 'WSL';
  if (base.includes('cmd')) return 'CMD';
  if (base.includes('zsh')) return 'Zsh';
  if (base.includes('fish')) return 'Fish';
  // Strip extension and capitalize
  const name = base.replace(/\.exe$/i, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}
