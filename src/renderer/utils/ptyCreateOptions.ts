import type { SpawnKind } from '../../shared/spawnKind';
import { applyRoleBinding, type RoleBinding } from '../../shared/orchestratorRole';

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
 * D2 — overlay a role's enforced agent/model binding onto the command a NEW pane
 * is created to run, when the pane's role is known at seed time (project layout /
 * saved teams). Applied ALONGSIDE withWorkspaceProfile at the command-assembly
 * sites so a seeded agent gets the same enforcement the orchestrator's
 * input.send rewrite provides.
 *
 * Covers BOTH bootstrap shapes the funnel can pick, since a wmux.json leaf may
 * declare a role next to either one:
 *   - `initialCommand` — typed into the pane's shell after boot,
 *   - `exec` — the X8 supervised unit run as the pane's root process.
 * Leaving `exec` out would have made `role` + `restart` on the same leaf a
 * silent no-op, which is the exact shape of dishonesty this feature is meant to
 * avoid. Only one is ever set at a time (the funnel chooses), but both are
 * handled rather than assumed.
 *
 * Pure + no-op-safe: returns the original object untouched when there is no
 * binding or no command to rewrite, or when the command already carries an
 * explicit `--model` (the transparent-rewrite rules live in applyRoleBinding). A
 * brand-new empty pane whose role is assigned AFTER creation is NOT covered here
 * — its enforcement guarantee is the Stage-2 input.send rewrite.
 */
export function withRoleBinding<T extends PtyCreateOptions>(
  options: T,
  binding: RoleBinding | undefined,
  role?: string,
): T {
  if (!binding) return options;
  const next = { ...options };
  let touched = false;
  for (const field of ['initialCommand', 'exec'] as const) {
    const before = options[field];
    if (before === undefined) continue;
    // `exec` is spawned as the pane's root process, so it cannot be prose typed
    // at a live agent — the shape a supervised agent leaf uses (`claude /loop`)
    // is a launch, and the submitted-line prose gate would wrongly reject it.
    const { command, changed } = applyRoleBinding(before, binding, {
      spawnedProcess: field === 'exec',
    });
    if (!changed) continue;
    next[field] = command;
    touched = true;
    // Audit trail: this path alters what a pane will RUN with no request/response
    // to carry a note (unlike input.send, which reports `enforcedModel` back to
    // the caller), so the rewrite would otherwise be invisible.
    console.log('[wmux:role-binding] seed command rewritten', { role, field, before, after: command });
  }
  return touched ? next : options;
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
 * Resolve the starting directory when a mounted Terminal SELF-CREATES a PTY
 * (issue #515). This is a fresh shell for a blank surface — recovery blank-slate,
 * rebind failure, or a dead-session respawn — so the workspace default is
 * authoritative and OUTRANKS the surface's tracked cwd.
 *
 * Priority differs from resolveStartupCwd on purpose: profile.startupCwd >
 * surface.cwd (prop) > global startupDirectory > undefined. A contaminated
 * surface whose tracked cwd points at home (funnel addSurface stored the main-
 * side homedir fallback, or an OSC-7-less agent pane never updated it) must NOT
 * win, or the reporter's panes never heal back to the configured startup dir.
 * When there is no profile.startupCwd the existing non-empty surface.cwd is
 * still honored, so a correctly-tracked pane respawns in place.
 */
export function resolveRespawnCwd(args: {
  surfaceCwd?: string;
  profile?: WorkspaceProfile;
  startupDirectory?: string;
}): string | undefined {
  if (args.profile?.startupCwd) return args.profile.startupCwd;
  if (args.surfaceCwd && args.surfaceCwd.trim().length > 0) return args.surfaceCwd;
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
