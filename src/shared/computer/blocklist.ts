// Apps computer use must never drive. Enforced in main before any request
// reaches a helper, so a helper bug cannot widen it.
//
// Deliberately short (owner decision 2026-10-08: a longer list made computer
// use slower than doing the task by hand). Why each group is here:
//   - password managers: an agent reading or typing into a vault is the worst
//     case for a prompt-injected screen.
//   - wmux itself: an agent could click its own approval dialog, or type into
//     another agent's pane.
//   - OS credential / elevation prompts: consent must come from the person.
// Terminals, system settings and other agent apps are allowed. Password
// managers inside a browser share their host's process and are not caught.
//
// Matching is by Windows executable basename and macOS bundle id — stable
// identifiers, not window titles an app controls.

import type { AppInfo, Key, Modifier } from './protocol';

export type BlockReason = 'password-manager' | 'wmux' | 'credential-prompt';

interface BlockEntry {
  reason: BlockReason;
  /** Lower-case Windows executable basenames. */
  exe?: readonly string[];
  /** macOS bundle ids; a trailing `*` matches a prefix. */
  bundle?: readonly string[];
  /**
   * Lower-case app names an openApp selector may use that no exe basename
   * spells (selectorBlockReasonFor). The launched app is re-checked anyway.
   */
  names?: readonly string[];
}

const BLOCKLIST: readonly BlockEntry[] = [
  {
    reason: 'password-manager',
    exe: [
      '1password.exe',
      'bitwarden.exe',
      'dashlane.exe',
      'lastpass.exe',
      'keepass.exe',
      'keepassxc.exe',
      'nordpass.exe',
      'proton pass.exe',
      'enpass.exe',
      'roboform.exe',
      'keeper password manager.exe',
    ],
    bundle: [
      'com.1password.*',
      'com.agilebits.*',
      'com.bitwarden.desktop',
      'com.dashlane.*',
      'com.lastpass.*',
      'org.keepassxc.keepassxc',
      'com.nordsec.nordpass',
      'me.proton.pass*',
      'in.sinew.Enpass-Desktop',
      'com.apple.keychainaccess',
      'com.apple.Passwords',
    ],
    names: ['keychain access', 'passwords', '1password 7'],
  },
  {
    reason: 'wmux',
    // forge.config.ts sets no appBundleId, so packager's default applies.
    // selfExePath/selfPids in BlockContext catch a renamed build.
    exe: ['wmux.exe'],
    bundle: ['com.electron.wmux'],
  },
  {
    reason: 'credential-prompt',
    exe: ['consent.exe', 'credentialuibroker.exe', 'logonui.exe', 'lockapp.exe'],
    bundle: ['com.apple.SecurityAgent', 'com.apple.systemuiserver', 'com.apple.loginwindow'],
  },
];

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

function bundleMatches(pattern: string, bundleId: string): boolean {
  if (pattern.endsWith('*')) return bundleId.startsWith(pattern.slice(0, -1));
  return bundleId === pattern;
}

export interface BlockContext {
  /** Process ids that belong to this wmux instance (main, renderers, helpers). */
  selfPids?: ReadonlySet<number>;
  /** Lower-cased executable path of this wmux instance. */
  selfExePath?: string;
}

/** Returns why `app` is blocked, or null when computer use may target it. */
export function blockReasonFor(app: Pick<AppInfo, 'pid' | 'path' | 'bundleId'>, ctx: BlockContext = {}): BlockReason | null {
  if (ctx.selfPids?.has(app.pid)) return 'wmux';
  if (ctx.selfExePath && app.path.toLowerCase() === ctx.selfExePath) return 'wmux';

  const exe = basename(app.path);
  for (const entry of BLOCKLIST) {
    if (entry.exe?.includes(exe)) return entry.reason;
    if (app.bundleId && entry.bundle?.some((p) => bundleMatches(p, app.bundleId as string))) return entry.reason;
  }
  return null;
}

/**
 * Why an openApp selector (an app name, bundle id, listApps id, exe or .app
 * path, or `pid:N`) names a blocked app, or null. Checked before anything is
 * launched; the app the helper resolved is checked again afterwards, so a
 * selector this misses is still refused, only after the launch.
 */
export function selectorBlockReasonFor(selector: string, ctx: BlockContext = {}): BlockReason | null {
  const lower = selector.trim().toLowerCase();
  if (!lower) return null;
  const pid = /^pid:(\d+)$/.exec(lower);
  if (pid) return ctx.selfPids?.has(Number(pid[1])) ? 'wmux' : null;
  if (ctx.selfExePath && lower === ctx.selfExePath) return 'wmux';
  // `/Applications/1Password.app` and `1Password` both come down to `1password`.
  const base = basename(lower.replace(/[\\/]+$/, '')).replace(/\.(app|exe)$/, '');
  for (const entry of BLOCKLIST) {
    if (entry.exe?.includes(`${base}.exe`)) return entry.reason;
    if (entry.bundle?.some((p) => bundleMatches(p.toLowerCase(), lower))) return entry.reason;
    if (entry.names?.includes(base)) return entry.reason;
  }
  return null;
}

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  'password-manager': 'password managers are never driven by agents',
  wmux: 'wmux cannot drive its own windows',
  'credential-prompt': 'system credential and elevation prompts need the person, not an agent',
};

// === OS-wide key chords ===
//
// Only chords that end the person's session or kill apps wholesale are
// refused: lock screen, log out, force quit, and the stop key itself. App
// switching, Start / Spotlight and Mission Control are allowed (owner decision
// 2026-10-08). Power and eject keys are outside the key vocabulary
// (protocol.ts), so the shutdown chords built on them cannot be sent at all.

const has = (mods: readonly Modifier[], ...want: Modifier[]) => want.every((m) => mods.includes(m));

/**
 * Why a chord must not be sent, or null when it may. `key` and `modifiers`
 * are canonical (protocol.ts). Platforms other than Windows and macOS have no
 * helper, so they get only the stop-key rule.
 */
export function osChordRefusal(platform: string, modifiers: readonly Modifier[], key: Key): string | null {
  // The stop key (Ctrl+Alt+Shift+Escape) and every Escape chord near it.
  if (key === 'Escape' && has(modifiers, 'ctrl', 'alt')) return 'it is the computer-use stop key or an OS shortcut';
  if (platform === 'win32') {
    if (key === 'l' && modifiers.includes('meta')) return 'Win+L locks the screen';
    if (key === 'x' && modifiers.includes('meta')) return 'Win+X opens the shut down and sign out menu';
    if (key === 'Delete' && has(modifiers, 'ctrl', 'alt')) return 'Ctrl+Alt+Delete is the secure attention sequence (lock, sign out)';
    if (key === 'Escape' && has(modifiers, 'ctrl', 'shift')) return 'Ctrl+Shift+Esc opens Task Manager, which force-quits apps';
    return null;
  }
  if (platform === 'darwin') {
    if (key === 'Escape' && has(modifiers, 'meta', 'alt')) return 'Cmd+Opt+Esc opens Force Quit';
    if (key === 'q' && has(modifiers, 'meta', 'ctrl')) return 'Ctrl+Cmd+Q locks the screen';
    if (key === 'q' && has(modifiers, 'meta', 'shift')) return 'Cmd+Shift+Q logs out';
    return null;
  }
  return null;
}
