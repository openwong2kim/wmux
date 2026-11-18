// The settings `wmux settings` (and the `settings.*` app actions) may read and
// change, and the ones only a person changes, in Settings.
//
// Every key here is a renderer setting that applies at once and changes how
// wmux looks or behaves for the person at it. Nothing here widens what an
// agent, another computer or a paired phone may do. Those settings, and any
// setting that runs a command, are listed in HUMAN_ONLY_SETTINGS instead: a
// call naming one is refused with the Settings section to use.

export type AppSettingSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'intChoice'; values: readonly number[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'number'; min: number; max: number; step: number }
  | { kind: 'bool' }
  /** A built-in theme id; the renderer knows the list. */
  | { kind: 'theme' }
  /** A supported language; the renderer knows the list. */
  | { kind: 'locale' }
  /** A font name; the renderer sanitizes it. */
  | { kind: 'font' };

const BOOL: AppSettingSpec = { kind: 'bool' };

export const APP_SETTINGS = {
  theme: { kind: 'theme' },
  locale: { kind: 'locale' },
  'terminal.fontSize': { kind: 'int', min: 8, max: 24 },
  'terminal.fontFamily': { kind: 'font' },
  'terminal.cursorStyle': { kind: 'enum', values: ['block', 'bar', 'underline'] },
  'terminal.scrollbackLines': { kind: 'int', min: 1000, max: 100000 },
  'terminal.openFileLinksIn': { kind: 'enum', values: ['wmux', 'os'] },
  'terminal.imagePaste': { kind: 'enum', values: ['auto', 'native', 'path'] },
  'terminal.splitInheritsCwd': BOOL,
  'terminal.closeTabOnExit': BOOL,
  'ui.scale': { kind: 'number', min: 0.8, max: 1.6, step: 0.05 },
  'sidebar.position': { kind: 'enum', values: ['left', 'right'] },
  'sidebar.sort': { kind: 'enum', values: ['attention', 'manual', 'recent'] },
  'fleet.layout': { kind: 'enum', values: ['list', 'board'] },
  'multiview.arrangement': { kind: 'enum', values: ['auto', 'columns', 'rows'] },
  'attention.blink': { kind: 'enum', values: ['off', 'once', 'remind', 'continuous'] },
  'attention.remindMs': { kind: 'intChoice', values: [30000, 60000, 300000] },
  'attention.finished': { kind: 'enum', values: ['dot', 'pulse'] },
  'notifications.toast': BOOL,
  'notifications.sound': BOOL,
  'notifications.osRing': BOOL,
  'notifications.paneRing': BOOL,
  'notifications.paneFlash': BOOL,
  'notifications.taskbarFlash': BOOL,
  'notifications.glowOpacity': { kind: 'number', min: 0.6, max: 1, step: 0.05 },
  'power.keepAwake': { kind: 'enum', values: ['off', 'working', 'always'] },
  'titlebar.clock': BOOL,
} as const satisfies Record<string, AppSettingSpec>;

export type AppSettingKey = keyof typeof APP_SETTINGS;
export type AppSettingValue = string | number | boolean;

export const APP_SETTING_KEYS = Object.keys(APP_SETTINGS) as AppSettingKey[];

export function isAppSettingKey(key: string): key is AppSettingKey {
  return Object.prototype.hasOwnProperty.call(APP_SETTINGS, key);
}

/**
 * Settings only a person changes, in the Settings section named. An id that
 * ends in '.' covers every key under it. Checked before the table, so a key
 * here can never be changed by an agent or the command line, whatever is
 * added to APP_SETTINGS later (a test keeps the two apart).
 */
export const HUMAN_ONLY_SETTINGS: ReadonlyArray<{ id: string; section: string }> = [
  // Approvals, fan-out and the worker fence.
  { id: 'approvals.', section: 'Roles & fan-out' },
  { id: 'a2a.autoApproveExecute', section: 'Roles & fan-out' },
  { id: 'fanout.', section: 'Roles & fan-out' },
  { id: 'workerFence', section: 'Roles & fan-out' },
  { id: 'workerFence.', section: 'Roles & fan-out' },
  { id: 'roles.', section: 'Roles & fan-out' },
  { id: 'customAgents', section: 'Roles & fan-out' },
  { id: 'grants.', section: 'Roles & fan-out' },
  // Claude Code integration and its automation.
  { id: 'claude.', section: 'Claude Code' },
  { id: 'usageLimitAutoResume', section: 'Claude Code' },
  { id: 'mcp.register', section: 'Claude Code' },
  { id: 'hooks', section: 'Claude Code' },
  { id: 'statusline', section: 'Claude Code' },
  // Accounts, tokens and the factory.
  { id: 'accounts.', section: 'Accounts' },
  { id: 'vault.', section: 'Accounts' },
  { id: 'tokens.', section: 'Token usage' },
  { id: 'factory.', section: 'Factory' },
  // What another computer or a paired phone may reach, and how.
  { id: 'lanlink.', section: 'LAN' },
  { id: 'a2a.listener', section: 'LAN' },
  { id: 'spawnPolicy', section: 'LAN' },
  { id: 'a2a.', section: 'LAN' },
  { id: 'remote.', section: 'Remote & phone' },
  { id: 'phone.', section: 'Remote & phone' },
  { id: 'tailscale', section: 'Remote & phone' },
  { id: 'quickCommands', section: 'Remote & phone' },
  // The browser and the desktop.
  { id: 'browser.', section: 'Browser' },
  { id: 'computerUse.', section: 'Computer use' },
  // Secrets, updates and start-up.
  { id: 'secretGuard', section: 'General' },
  { id: 'secretHook', section: 'General' },
  { id: 'credentialEnv', section: 'General' },
  { id: 'autoUpdate', section: 'General' },
  { id: 'startOnLogin', section: 'General' },
  // Settings that run a command.
  { id: 'terminal.defaultShell', section: 'Terminal' },
  { id: 'terminal.wslDistro', section: 'Terminal' },
  { id: 'terminal.startupDirectory', section: 'Terminal' },
  { id: 'shortcuts.', section: 'Shortcuts' },
  { id: 'keybindings', section: 'Shortcuts' },
];

/** The Settings section for a human-only key, or undefined. Case-insensitive. */
export function humanOnlySettingSection(key: string): string | undefined {
  const k = key.trim().toLowerCase();
  for (const { id, section } of HUMAN_ONLY_SETTINGS) {
    const i = id.toLowerCase();
    if (i.endsWith('.') ? k.startsWith(i) : k === i || k.startsWith(`${i}.`)) return section;
  }
  return undefined;
}

/**
 * Why `key` cannot be read or changed here, or undefined when it can: a
 * human-only key names its Settings section, any other unknown key points at
 * the list.
 */
export function appSettingKeyRefusal(key: string): string | undefined {
  const section = humanOnlySettingSection(key);
  if (section) return `${key} is changed by a person in Settings › ${section}, not by an agent or the command line`;
  if (!isAppSettingKey(key)) return `no setting "${key}" (\`wmux settings list\` shows the ones that can change)`;
  return undefined;
}

const TRUE_WORDS = new Set(['true', 'on', '1', 'yes']);
const FALSE_WORDS = new Set(['false', 'off', '0', 'no']);

export type AppSettingParse = { ok: true; value: AppSettingValue } | { ok: false; error: string };

/**
 * The value to store for `key`, from what a caller sent. Enum and bool words
 * are trimmed and read in any case. Theme, locale and font come back as the
 * trimmed text; the renderer checks those against what it has.
 */
export function parseAppSetting(key: AppSettingKey, raw: string | number | boolean): AppSettingParse {
  const spec: AppSettingSpec = APP_SETTINGS[key];
  const text = String(raw).trim();
  const bad = (what: string): AppSettingParse => ({ ok: false, error: `${key} must be ${what}` });
  switch (spec.kind) {
    case 'bool':
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (TRUE_WORDS.has(text.toLowerCase())) return { ok: true, value: true };
      if (FALSE_WORDS.has(text.toLowerCase())) return { ok: true, value: false };
      return bad('on or off (true/false, 1/0, yes/no)');
    case 'enum': {
      const v = spec.values.find((x) => x === text.toLowerCase());
      return v ? { ok: true, value: v } : bad(`one of ${spec.values.join(', ')}`);
    }
    case 'intChoice': {
      const n = Number(text);
      return spec.values.includes(n) ? { ok: true, value: n } : bad(`one of ${spec.values.join(', ')}`);
    }
    case 'int': {
      const n = text === '' ? NaN : Number(text);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) return bad(`a whole number from ${spec.min} to ${spec.max}`);
      return { ok: true, value: n };
    }
    case 'number': {
      const n = text === '' ? NaN : Number(text);
      const steps = (n - spec.min) / spec.step;
      const snapped = Math.round(steps);
      if (!Number.isFinite(n) || n < spec.min - 1e-9 || n > spec.max + 1e-9 || Math.abs(steps - snapped) > 1e-6) {
        return bad(`a number from ${spec.min} to ${spec.max} in steps of ${spec.step}`);
      }
      // The stored form of the step it names, so the same value reads as unchanged.
      return { ok: true, value: Number((spec.min + snapped * spec.step).toFixed(2)) };
    }
    case 'theme':
    case 'locale':
    case 'font':
      if (!text) return bad('a name');
      return { ok: true, value: text };
  }
}

/** The allowed values in words, for `wmux settings list`; theme and locale come from the renderer. */
export function describeAppSetting(key: AppSettingKey): string {
  const spec: AppSettingSpec = APP_SETTINGS[key];
  switch (spec.kind) {
    case 'bool': return 'on|off';
    case 'enum': return spec.values.join('|');
    case 'intChoice': return spec.values.join('|');
    case 'int': return `${spec.min}-${spec.max}`;
    case 'number': return `${spec.min}-${spec.max} step ${spec.step}`;
    case 'theme': return 'a theme id';
    case 'locale': return 'a language code';
    case 'font': return 'a font name';
  }
}
