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
//
// Matching is by Windows executable basename and macOS bundle id — stable
// identifiers, not window titles an app controls.

import type { AppInfo } from './protocol';

export type BlockReason = 'password-manager' | 'wmux' | 'terminal' | 'credential-prompt';

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
    ],
    bundle: [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'dev.warp.Warp-Stable',
      'com.github.wez.wezterm',
      'io.alacritty',
      'net.kovidgoyal.kitty',
      'co.zeit.hyper',
      'org.tabby',
      'com.mitchellh.ghostty',
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

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  'password-manager': 'password managers are never driven by agents',
  wmux: 'wmux cannot drive its own windows',
  terminal: 'terminals and agent apps are blocked because they would bypass command approvals',
  'credential-prompt': 'system credential and elevation prompts need the person, not an agent',
};
