// Apps computer use must never drive. Enforced in main before any request
// reaches a helper, so a helper bug cannot widen it.
//
// Why each group is here:
//   - password managers: an agent reading or typing into a vault is the worst
//     case for a prompt-injected screen.
//   - wmux itself: an agent could click its own approval dialog, or type into
//     another agent's pane.
//   - terminals and agent hosts: driving one runs shell commands outside every
//     approval wmux and the agent CLIs enforce.
//   - OS credential / elevation prompts: consent must come from the person.
//   - system tools: System Settings / Windows Settings (an agent on the
//     Privacy & Security pane could grant itself permissions), script
//     runners (Script Editor, Automator, Shortcuts, Registry Editor) and
//     process managers (Activity Monitor, Task Manager and its "Run new task").
//
// explorer.exe is both the Windows shell and File Explorer, so it is judged
// per window (windowBlockReasonFor): only folder windows on a filesystem path
// may be driven; every other shell window (the desktop, the taskbar, the Run
// dialog, Control Panel and other shell-namespace locations, a folder window
// whose location is unknown) is a shell system surface. Terminals inside an
// IDE and password managers inside a browser share their host's process.
//
// Matching is by Windows executable basename and macOS bundle id — stable
// identifiers, not window titles an app controls.

import type { AppInfo, Key, Modifier, WindowInfo } from './protocol';

export type BlockReason = 'password-manager' | 'wmux' | 'terminal' | 'credential-prompt' | 'system-tool';

interface BlockEntry {
  reason: BlockReason;
  /** Lower-case Windows executable basenames. */
  exe?: readonly string[];
  /** macOS bundle ids; a trailing `*` matches a prefix. */
  bundle?: readonly string[];
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
  },
  {
    reason: 'wmux',
    // forge.config.ts sets no appBundleId, so packager's default applies.
    // selfExePath/selfPids in BlockContext catch a renamed build.
    exe: ['wmux.exe'],
    bundle: ['com.electron.wmux'],
  },
  {
    reason: 'terminal',
    exe: [
      'windowsterminal.exe',
      'wt.exe',
      'openconsole.exe',
      'conhost.exe',
      'cmd.exe',
      'powershell.exe',
      'pwsh.exe',
      'mintty.exe',
      'alacritty.exe',
      'wezterm-gui.exe',
      'warp.exe',
      'tabby.exe',
      'hyper.exe',
      'kitty.exe',
      'claude.exe',
      'codex.exe',
      'chatgpt.exe',
      'bash.exe',
      'wsl.exe',
      'wslhost.exe',
      'git-bash.exe',
      'nu.exe',
      'conemu.exe',
      'conemu64.exe',
      'cmder.exe',
      'putty.exe',
      'termius.exe',
      'ghostty.exe',
      'rio.exe',
      'waveterm.exe',
    ],
    bundle: [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'dev.warp.Warp*',
      'com.github.wez.wezterm',
      'io.alacritty',
      'org.alacritty',
      'net.kovidgoyal.kitty',
      'co.zeit.hyper',
      'org.tabby',
      'com.mitchellh.ghostty',
      'com.raphaelamorim.rio',
      'dev.commandline.waveterm',
      'com.termius-dmg.mac',
      'com.panic.prompt3',
      'com.anthropic.claudefordesktop',
      'com.openai.chat',
      'com.openai.codex',
    ],
  },
  {
    reason: 'credential-prompt',
    exe: ['consent.exe', 'credentialuibroker.exe', 'logonui.exe', 'lockapp.exe'],
    bundle: ['com.apple.SecurityAgent', 'com.apple.systemuiserver', 'com.apple.loginwindow'],
  },
  {
    reason: 'system-tool',
    exe: [
      'taskmgr.exe',
      'regedit.exe',
      'regedt32.exe',
      'mmc.exe',
      'systemsettings.exe',
      'control.exe',
      // GUI script hosts: each one runs arbitrary code from a window.
      'powershell_ise.exe',
      'mshta.exe',
      'wscript.exe',
      'cscript.exe',
    ],
    bundle: [
      'com.apple.systempreferences',
      'com.apple.ScriptEditor2',
      'com.apple.Automator',
      'com.apple.shortcuts',
      'com.apple.ActivityMonitor',
    ],
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

/** File Explorer's folder window classes. */
const FOLDER_WINDOW_CLASSES: ReadonlySet<string> = new Set(['CabinetWClass', 'ExploreWClass']);

/** `C:\…` or `\\server\share\…`; not `\\?\` or `\\.\` device paths, not `::{GUID}` locations. */
export function isFilesystemLocation(location: string | undefined): boolean {
  if (!location) return false;
  return /^[A-Za-z]:\\/.test(location) || /^\\\\[^\\?.][^\\]*\\[^\\]+/.test(location);
}

/**
 * Why one window of an app that is not blocked as a whole must still not be
 * driven, or null. Windows only: explorer.exe windows are allowed only as
 * folder windows (CabinetWClass / ExploreWClass) whose `shellLocation` the
 * helper reported as a filesystem path; everything else explorer.exe shows is
 * a shell system surface. Fails closed when the class or location is missing.
 */
export function windowBlockReasonFor(
  app: Pick<AppInfo, 'path' | 'bundleId'>,
  window: Pick<WindowInfo, 'className' | 'shellLocation'>,
): BlockReason | null {
  if (!windowRuleDependsOnLocation(app)) return null;
  if (window.className && FOLDER_WINDOW_CLASSES.has(window.className) && isFilesystemLocation(window.shellLocation)) {
    return null;
  }
  return 'system-tool';
}

/** Whether windowBlockReasonFor's answer for this app can change while a window stays open. */
export function windowRuleDependsOnLocation(app: Pick<AppInfo, 'path' | 'bundleId'>): boolean {
  return !app.bundleId && basename(app.path) === 'explorer.exe';
}

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  'password-manager': 'password managers are never driven by agents',
  wmux: 'wmux cannot drive its own windows',
  terminal: 'terminals and agent apps are blocked because they would bypass command approvals',
  'credential-prompt': 'system credential and elevation prompts need the person, not an agent',
  'system-tool': 'system settings, script runners and process managers can grant permissions or run code, so they need the person',
};

// === OS-wide key chords ===
//
// A chord that acts on the whole system rather than the vetted window
// (switching apps, opening Start or Spotlight, locking the screen, the stop key
// itself) would escape per-app consent, so main refuses it before the helper
// sees it. App-level chords stay allowed even when they change the window:
// Alt+F4 / Cmd+Q close the vetted app, Ctrl+Cmd+F toggles its full screen.
// On macOS the bare F3, F4, F11 and F12 are refused too: by default they open
// Mission Control, Launchpad, show the desktop and the widgets, and a
// synthetic key cannot tell whether the person remapped them.

type ChordPlatform = 'win32' | 'darwin';

const has = (mods: readonly Modifier[], ...want: Modifier[]) => want.every((m) => mods.includes(m));

/**
 * Why modifiers held during a click must not be sent, or null when they may.
 * A Windows-key click is not an app gesture, so the platform rule for meta
 * applies to pointer batches too.
 */
export function osPointerModifierRefusal(platform: string, modifiers: readonly Modifier[]): string | null {
  if ((platform as ChordPlatform) === 'win32' && modifiers.includes('meta')) {
    return 'Windows-key shortcuts act on the whole system';
  }
  return null;
}

/**
 * Why a chord must not be sent, or null when it may. `key` and `modifiers`
 * are canonical (protocol.ts). Platforms other than Windows and macOS have no
 * helper, so they get no rule.
 */
export function osChordRefusal(platform: string, modifiers: readonly Modifier[], key: Key): string | null {
  // The stop key (Ctrl+Alt+Shift+Escape) and every Escape chord near it.
  if (key === 'Escape' && has(modifiers, 'ctrl', 'alt')) return 'it is the computer-use stop key or an OS shortcut';
  if ((platform as ChordPlatform) === 'win32') {
    if (modifiers.includes('meta')) return 'Windows-key shortcuts act on the whole system';
    if (key === 'Tab' && modifiers.includes('alt')) return 'Alt+Tab switches to another app';
    if (key === 'Escape' && (modifiers.includes('ctrl') || modifiers.includes('alt'))) {
      return 'Ctrl+Esc, Alt+Esc and Ctrl+Shift+Esc open Start, switch apps or open Task Manager';
    }
    if (key === 'Delete' && has(modifiers, 'ctrl', 'alt')) return 'Ctrl+Alt+Delete is the secure attention sequence';
    if (key === 'Space' && modifiers.includes('alt')) return 'Alt+Space opens the window menu (move, size, close) or system search';
    return null;
  }
  if ((platform as ChordPlatform) === 'darwin') {
    if (key === 'Tab' && modifiers.includes('meta')) return 'Cmd+Tab switches to another app';
    if (key === 'Space' && (modifiers.includes('meta') || modifiers.includes('ctrl'))) {
      return 'Cmd+Space and Ctrl+Space open Spotlight or switch the input source';
    }
    if (key === 'Escape' && modifiers.includes('meta')) return 'Cmd+Opt+Esc opens Force Quit';
    if (key === 'q' && (has(modifiers, 'meta', 'ctrl') || has(modifiers, 'meta', 'shift'))) {
      return 'Ctrl+Cmd+Q locks the screen and Cmd+Shift+Q logs out';
    }
    if ((key === 'd' || key === 'h') && has(modifiers, 'meta', 'alt')) return 'it hides the Dock or every other app';
    if (['3', '4', '5', '6'].includes(key) && has(modifiers, 'meta', 'shift')) return 'it captures or records the whole screen';
    if (key.startsWith('Arrow') && modifiers.includes('ctrl')) return 'Ctrl+arrow opens Mission Control or switches Spaces';
    if (/^F\d+$/.test(key) && modifiers.includes('ctrl')) return 'Ctrl+F-keys move keyboard focus to the menu bar, Dock or other system UI';
    if (/^F\d+$/.test(key) && modifiers.includes('meta')) {
      return 'Cmd+F-keys mirror displays, show the desktop or toggle VoiceOver and accessibility shortcuts';
    }
    if (['F3', 'F4', 'F11', 'F12'].includes(key) && modifiers.length === 0) {
      return 'F3, F4, F11 and F12 open Mission Control, Launchpad, the desktop or widgets';
    }
    if (key === '8' && has(modifiers, 'meta', 'alt')) return 'Cmd+Opt+8 toggles Zoom and Ctrl+Opt+Cmd+8 inverts colours';
    return null;
  }
  return null;
}
