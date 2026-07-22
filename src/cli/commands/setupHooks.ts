import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `wmux setup-hooks` — install the wmux ↔ Claude Code hook bridge directly into
 * Claude Code's user settings (`~/.claude/settings.json`), WITHOUT requiring the
 * `/plugin marketplace add` flow. This is the plugin-LESS alternative to the
 * `wmux-claude-integration` Claude Code plugin: same 4 hook events, same proven
 * bridge script, but registered by editing settings.json instead of installing a
 * marketplace plugin.
 *
 * Why settings.json + a stable bridge path (NOT the install dir):
 *   Squirrel.Windows installs wmux into versioned `app-x.y.z` directories that
 *   change on every update. A hook command pointing into the install dir would
 *   break the moment the app updates. So we copy the bridge to a stable location
 *   under `~/.wmux/hooks/` and reference THAT path from settings.json — it
 *   survives app updates, and every `setup-hooks` run refreshes the copy so the
 *   bridge stays in sync with the installed app.
 *
 * Style mirrors `src/cli/commands/mcp.ts`: atomic tmp+rename writes,
 * prototype-pollution-safe JSON.parse reviver, findScript() upward-walk asset
 * discovery, and RegisterOutcome-style result objects.
 */

const HELP_TEXT = `
wmux setup-hooks — install Claude Code hooks without the marketplace plugin

USAGE
  wmux setup-hooks [--remove | --status] [--json]

ACTIONS (mutually exclusive; default = install)
  (default)    Install wmux hook entries into ~/.claude/settings.json and copy
               the bridge to ~/.wmux/hooks/wmux-bridge.mjs.
  --remove     Remove only the wmux-owned hook entries (leaves your other hooks).
  --status     Report whether wmux hooks are installed, whether the copied bridge
               is up to date, and a double-signal warning if the plugin is also
               installed.

GLOBAL FLAGS
  --json       Output raw JSON (useful for scripting).
`.trimStart();

/** The Claude Code hook events wmux subscribes to (mirrors hooks.json).
 *  PostToolUse was removed 2026-07-13: it fired a ~110ms node bridge on EVERY
 *  tool call only to feed the fleet "running" dot, which the daemon's
 *  byte-based ActivityMonitor now drives for free (see markSurfaceRunning). */
const HOOK_EVENTS = ['Stop', 'SubagentStop', 'SessionStart'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

/** Substring that identifies a wmux-owned hook command in settings.json. */
const WMUX_BRIDGE_MARKER = 'wmux-bridge.mjs';

/** Substring that identifies the wmux Claude Code marketplace plugin. */
const WMUX_PLUGIN_MARKER = 'wmux-claude-integration';

/**
 * Filesystem paths the command operates on. Injectable so unit tests can point
 * at a temp dir and never touch the real HOME. `mcp.ts` hardcodes os.homedir();
 * we take the injectable route here because settings.json carries far more user
 * config than `.claude.json` and tests must be guaranteed not to clobber it.
 */
export interface SetupHooksPaths {
  /** Claude Code user settings: `~/.claude/settings.json`. */
  settingsPath: string;
  /** Stable bridge install location: `~/.wmux/hooks/wmux-bridge.mjs`. */
  bridgeDest: string;
  /** Bundled bridge source, or null when it could not be located. */
  bridgeSource: string | null;
}

export function defaultPaths(): SetupHooksPaths {
  const home = os.homedir();
  return {
    settingsPath: path.join(home, '.claude', 'settings.json'),
    bridgeDest: path.join(home, '.wmux', 'hooks', 'wmux-bridge.mjs'),
    bridgeSource: findBridgeSource(),
  };
}

/**
 * Locate the bundled bridge script. Walks up from the calling module's
 * directory (same approach as mcp.ts findScript) trying, in order:
 *   - `wmux-bridge.mjs`                        (next to the bundled CLI — CLI 실행 시)
 *   - `cli-bundle/wmux-bridge.mjs`             (패키징 앱의 메인 프로세스 — __dirname이
 *                                               app.asar/.vite/build라 walk-up이
 *                                               Resources에 닿았을 때 cli-bundle/로 진입)
 *   - `dist/cli-bundle/wmux-bridge.mjs`        (repo dist after `build:cli`)
 *   - `integrations/claude/bin/wmux-bridge.mjs` (dev fallback — repo checkout)
 * Returns null when none exist, in which case install aborts with guidance.
 * 주의: 이 함수는 CLI뿐 아니라 hooksBridge.handler(메인 프로세스, 인앱 "hook 설치"
 * 버튼)에서도 호출된다 — cli-bundle/ 후보가 없으면 인앱 설치가 항상 실패한다(#489 후속).
 */
export function findBridgeSourceFrom(startDir: string): string | null {
  const candidates = [
    'wmux-bridge.mjs',
    path.join('cli-bundle', 'wmux-bridge.mjs'),
    path.join('dist', 'cli-bundle', 'wmux-bridge.mjs'),
    path.join('integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
  ];
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    for (const rel of candidates) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findBridgeSource(): string | null {
  return findBridgeSourceFrom(__dirname);
}

/**
 * Prototype-pollution-safe JSON.parse reviver — strips dangerous keys so a
 * malicious settings.json cannot poison Object.prototype. Same shape as mcp.ts.
 */
function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

/**
 * Atomic write — tmp + rename — so a partial write can never leave Claude Code
 * with an unparseable settings.json. Pretty-printed 2-space + trailing newline.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Build the command string for a hook event, referencing the stable bridge path. */
function bridgeCommand(bridgeDest: string, event: HookEvent): string {
  // Mirror hooks.json shape: `node "<abs path>" <HookName>`. Quote the path so
  // spaces in the home directory don't break the command.
  return `node "${bridgeDest}" ${event}`;
}

/** A single hook command leaf, e.g. { type: 'command', command: '…' }. */
interface HookLeaf {
  type: string;
  command: string;
}
/** A matcher group, e.g. { matcher: '', hooks: [HookLeaf, …] }. */
interface HookGroup {
  matcher?: string;
  hooks?: HookLeaf[];
  [k: string]: unknown;
}

/** True when a hook group contains a wmux-owned command leaf. */
function isWmuxGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h &&
      typeof h === 'object' &&
      typeof (h as HookLeaf).command === 'string' &&
      (h as HookLeaf).command.includes(WMUX_BRIDGE_MARKER),
  );
}

// ----- Settings load (corruption-aware) -----------------------------------

interface LoadResult {
  /** Parsed settings object (empty when the file is absent). */
  settings: Record<string, unknown>;
  exists: boolean;
  /** Set when the file exists but is unparseable — caller MUST abort. */
  corrupted: boolean;
}

/**
 * Read settings.json. A missing file is fine (returns an empty object to seed a
 * fresh install). A file that exists but does not parse is reported as corrupted
 * so the caller can ABORT — unlike mcp.ts's `.claude.json` recovery choice, we
 * never overwrite a corrupted settings.json because it carries far more user
 * config (model, permissions, env, statusline, …) and silently clobbering it
 * would be destructive.
 */
function loadSettings(settingsPath: string): LoadResult {
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, exists: false, corrupted: false };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return { settings: {}, exists: true, corrupted: true };
  }
  // An empty file is treated as an empty object, not corruption.
  if (raw.trim().length === 0) {
    return { settings: {}, exists: true, corrupted: false };
  }
  try {
    const parsed = JSON.parse(raw, safeReviver) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: {}, exists: true, corrupted: true };
    }
    return { settings: parsed as Record<string, unknown>, exists: true, corrupted: false };
  } catch {
    return { settings: {}, exists: true, corrupted: true };
  }
}

/**
 * Strip all wmux-owned hook groups from a settings.hooks map, dropping any event
 * arrays (and the `hooks` key itself) left empty. Returns the count removed.
 * Mutates `settings` in place. Used by both install (clear-then-add) and remove.
 */
function stripWmuxHooks(settings: Record<string, unknown>): number {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  const hooksMap = hooks as Record<string, unknown>;
  let removed = 0;
  for (const event of Object.keys(hooksMap)) {
    const groups = hooksMap[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isWmuxGroup(g));
    removed += groups.length - kept.length;
    if (kept.length === 0) {
      delete hooksMap[event];
    } else {
      hooksMap[event] = kept;
    }
  }
  if (Object.keys(hooksMap).length === 0) {
    delete settings.hooks;
  }
  return removed;
}

// ----- Plugin manifest detection ------------------------------------------

/** Recursively test whether any object key OR string value contains `needle`. */
function jsonMentions(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) {
    return value.some((v) => jsonMentions(v, needle, depth + 1));
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.includes(needle)) return true;
      if (jsonMentions(v, needle, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Authoritative install-time detection of the `wmux-claude-integration`
 * marketplace plugin via Claude Code's installed-plugins manifest
 * (`<claudeDir>/plugins/installed_plugins.json`). Returns true when the manifest
 * references the plugin by key or value. A missing OR malformed manifest is
 * tolerated and treated as "not installed" — fail-open to the plugin-LESS
 * install path so a corrupt manifest never blocks `wmux setup-hooks`.
 */
function detectPluginViaManifest(settingsPath: string): boolean {
  const manifestPath = path.join(path.dirname(settingsPath), 'plugins', 'installed_plugins.json');
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return false; // absent / unreadable
  }
  try {
    const parsed = JSON.parse(raw, safeReviver) as unknown;
    return jsonMentions(parsed, WMUX_PLUGIN_MARKER);
  } catch {
    return false; // malformed
  }
}

/**
 * A plugin can be INSTALLED (listed in installed_plugins.json) yet DISABLED
 * through Claude Code's `enabledPlugins` settings map — in which case its
 * hooks.json is NOT loaded. Treating such a plugin as active would strip the
 * working settings.json hook entries and leave the user with no wmux hooks at
 * all (codex review). Only an EXPLICIT `false` counts as disabled: an entry
 * absent from `enabledPlugins` means Claude Code runs the installed plugin.
 */
function isPluginExplicitlyDisabled(settings: Record<string, unknown>): boolean {
  const enabled = settings['enabledPlugins'];
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return false;
  for (const [key, value] of Object.entries(enabled as Record<string, unknown>)) {
    if (key.includes(WMUX_PLUGIN_MARKER) && value === false) return true;
  }
  return false;
}

// ----- Bridge copy --------------------------------------------------------

interface BridgeCopyResult {
  copied: boolean;
  /** Set when the source could not be located. */
  warning: string | null;
}

/** Copy the bundled bridge to the stable dest, overwriting any existing copy. */
function copyBridge(paths: SetupHooksPaths): BridgeCopyResult {
  if (!paths.bridgeSource) {
    return {
      copied: false,
      warning:
        'Could not locate the bundled wmux-bridge.mjs next to this CLI. Reinstall wmux or run from a repo checkout.',
    };
  }
  const dir = path.dirname(paths.bridgeDest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(paths.bridgeSource, paths.bridgeDest);
  return { copied: true, warning: null };
}

// ----- Install ------------------------------------------------------------

export interface InstallOutcome {
  ok: boolean;
  settingsPath: string;
  bridgeDest: string;
  bridgeSource: string | null;
  /** Events written into settings.json. */
  events: HookEvent[];
  bridgeCopied: boolean;
  /**
   * True when the wmux-claude-integration marketplace plugin was detected. In
   * that case we do NOT write hook entries (the plugin owns them) and instead
   * strip any duplicate settings.json entries to prevent double signals.
   */
  pluginDetected: boolean;
  /** Duplicate wmux hook groups removed because the plugin already owns them. */
  removedForPlugin: number;
  /** Non-fatal warning (e.g. partial copy), or null. */
  warning: string | null;
  /** Fatal error (corruption / missing bridge); when set, ok is false. */
  error: string | null;
}

export function installHooks(paths: SetupHooksPaths): InstallOutcome {
  const base: InstallOutcome = {
    ok: false,
    settingsPath: paths.settingsPath,
    bridgeDest: paths.bridgeDest,
    bridgeSource: paths.bridgeSource,
    events: [],
    bridgeCopied: false,
    pluginDetected: false,
    removedForPlugin: 0,
    warning: null,
    error: null,
  };

  // 1. Load settings; abort on corruption rather than clobbering user config.
  //    Done before touching the bridge so a corrupt config never triggers a
  //    pointless copy, and so plugin detection can gate the whole install.
  const load = loadSettings(paths.settingsPath);
  if (load.corrupted) {
    return {
      ...base,
      error:
        `settings.json at ${paths.settingsPath} is not valid JSON — aborting to avoid ` +
        `overwriting your Claude Code config. Fix or remove the file and re-run.`,
    };
  }

  const settings = load.settings;

  // 2. Plugin-aware short-circuit: when the wmux-claude-integration marketplace
  //    plugin is installed AND enabled it already registers these hooks.
  //    Writing them here too would double every Stop/SubagentStop/SessionStart
  //    signal, so we skip the install and instead strip any duplicate
  //    settings.json entries left over from a previous plugin-LESS run. All
  //    foreign hooks are preserved. An installed-but-DISABLED plugin loads no
  //    hooks, so it must NOT short-circuit — the settings.json entries are the
  //    only live installation in that case (codex review).
  if (detectPluginViaManifest(paths.settingsPath) && !isPluginExplicitlyDisabled(settings)) {
    const removedForPlugin = stripWmuxHooks(settings);
    if (removedForPlugin > 0) {
      writeJsonAtomic(paths.settingsPath, settings);
    }
    return { ...base, ok: true, pluginDetected: true, removedForPlugin };
  }

  // 3. Locate + copy the bridge; without it the hooks would be inert.
  const copy = copyBridge(paths);
  if (!copy.copied) {
    return { ...base, error: copy.warning };
  }

  // 4. Idempotent merge: drop any stale wmux groups first, then append fresh
  //    ones. This preserves all foreign hooks and every other settings key.
  stripWmuxHooks(settings);

  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};

  for (const event of HOOK_EVENTS) {
    const group: HookGroup = {
      matcher: '',
      hooks: [{ type: 'command', command: bridgeCommand(paths.bridgeDest, event) }],
    };
    const existing = hooks[event];
    hooks[event] = Array.isArray(existing) ? [...existing, group] : [group];
  }
  settings.hooks = hooks;

  // 4. Atomic write.
  writeJsonAtomic(paths.settingsPath, settings);

  return {
    ...base,
    ok: true,
    bridgeCopied: true,
    events: [...HOOK_EVENTS],
  };
}

// ----- Remove -------------------------------------------------------------

export interface RemoveOutcome {
  ok: boolean;
  settingsPath: string;
  settingsExisted: boolean;
  /** Number of wmux hook groups removed. */
  removed: number;
  error: string | null;
}

export function removeHooks(paths: SetupHooksPaths): RemoveOutcome {
  const load = loadSettings(paths.settingsPath);
  if (!load.exists) {
    return { ok: true, settingsPath: paths.settingsPath, settingsExisted: false, removed: 0, error: null };
  }
  if (load.corrupted) {
    return {
      ok: false,
      settingsPath: paths.settingsPath,
      settingsExisted: true,
      removed: 0,
      error:
        `settings.json at ${paths.settingsPath} is not valid JSON — aborting to avoid ` +
        `overwriting your Claude Code config. Fix or remove the file and re-run.`,
    };
  }

  const settings = load.settings;
  const removed = stripWmuxHooks(settings);
  if (removed > 0) {
    writeJsonAtomic(paths.settingsPath, settings);
  }
  return { ok: true, settingsPath: paths.settingsPath, settingsExisted: true, removed, error: null };
}

// ----- Status -------------------------------------------------------------

export interface StatusOutcome {
  settingsPath: string;
  settingsExists: boolean;
  settingsCorrupted: boolean;
  /** wmux hook events currently present in settings.json. */
  installedEvents: HookEvent[];
  bridgeDest: string;
  bridgeExists: boolean;
  bridgeSource: string | null;
  /** True when the copied bridge differs from the bundled source (stale). */
  bridgeStale: boolean;
  /**
   * True when BOTH this settings.json install and the marketplace plugin appear
   * active — each turn would then fire double signals. Best-effort detection.
   */
  pluginAlsoInstalled: boolean;
}

/**
 * Best-effort detection of the `wmux-claude-integration` marketplace plugin.
 * Claude Code stores installed plugins under `~/.claude/plugins/`. We only need
 * a heuristic for the double-signal warning, so a directory-name match is enough.
 */
function detectPluginInstalled(settingsPath: string): boolean {
  // settingsPath is `<claudeDir>/settings.json`; the plugins live next to it.
  const claudeDir = path.dirname(settingsPath);
  const pluginsDir = path.join(claudeDir, 'plugins');
  try {
    if (!fs.existsSync(pluginsDir)) return false;
    const stack = [pluginsDir];
    let depth = 0;
    while (stack.length > 0 && depth < 5000) {
      const cur = stack.pop() as string;
      depth++;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'wmux-claude-integration') return true;
        stack.push(path.join(cur, e.name));
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function statusHooks(paths: SetupHooksPaths): StatusOutcome {
  const load = loadSettings(paths.settingsPath);

  const installedEvents: HookEvent[] = [];
  if (!load.corrupted) {
    const hooks = load.settings.hooks;
    if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
      const hooksMap = hooks as Record<string, unknown>;
      for (const event of HOOK_EVENTS) {
        const groups = hooksMap[event];
        if (Array.isArray(groups) && groups.some((g) => isWmuxGroup(g))) {
          installedEvents.push(event);
        }
      }
    }
  }

  const bridgeExists = fs.existsSync(paths.bridgeDest);
  let bridgeStale = false;
  if (bridgeExists && paths.bridgeSource && fs.existsSync(paths.bridgeSource)) {
    try {
      const a = fs.readFileSync(paths.bridgeDest);
      const b = fs.readFileSync(paths.bridgeSource);
      bridgeStale = !a.equals(b);
    } catch {
      bridgeStale = false;
    }
  }

  return {
    settingsPath: paths.settingsPath,
    settingsExists: load.exists,
    settingsCorrupted: load.corrupted,
    installedEvents,
    bridgeDest: paths.bridgeDest,
    bridgeExists,
    bridgeSource: paths.bridgeSource,
    bridgeStale,
    pluginAlsoInstalled: detectPluginInstalled(paths.settingsPath),
  };
}

// ----- Printing -----------------------------------------------------------

function printInstall(outcome: InstallOutcome, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (!outcome.ok) {
    if (outcome.error) console.error(outcome.error);
    return;
  }
  if (outcome.pluginDetected) {
    console.log('Detected the wmux-claude-integration plugin — it already registers these hooks.');
    console.log('Skipped writing settings.json hook entries to avoid double signals.');
    if (outcome.removedForPlugin > 0) {
      console.log(
        `Removed ${outcome.removedForPlugin} duplicate wmux hook entr${outcome.removedForPlugin === 1 ? 'y' : 'ies'} from ${outcome.settingsPath}.`,
      );
      console.log('Restart your Claude Code session for the change to take effect.');
    } else {
      console.log('No duplicate wmux hook entries in settings.json — nothing to change.');
    }
    return;
  }
  console.log(`Copied bridge → ${outcome.bridgeDest}`);
  console.log(`Updated settings → ${outcome.settingsPath}`);
  console.log(`Installed hooks for: ${outcome.events.join(', ')}`);
  if (outcome.warning) console.warn(outcome.warning);
  console.log('Restart your Claude Code session for the hooks to take effect.');
}

function printRemove(outcome: RemoveOutcome, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (!outcome.ok) {
    if (outcome.error) console.error(outcome.error);
    return;
  }
  if (!outcome.settingsExisted) {
    console.log(`No settings file at ${outcome.settingsPath} — nothing to remove.`);
    return;
  }
  if (outcome.removed === 0) {
    console.log('No wmux hooks found in settings.json — nothing changed.');
    return;
  }
  console.log(`Removed ${outcome.removed} wmux hook entr${outcome.removed === 1 ? 'y' : 'ies'} from ${outcome.settingsPath}`);
  console.log('Restart your Claude Code session for the change to take effect.');
}

function printStatus(outcome: StatusOutcome, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (outcome.settingsCorrupted) {
    console.log(`settings: ${outcome.settingsPath} (UNPARSEABLE — fix before installing)`);
  } else if (outcome.installedEvents.length > 0) {
    console.log(`settings: wmux hooks installed for ${outcome.installedEvents.join(', ')}`);
  } else {
    console.log('settings: wmux hooks NOT installed — run `wmux setup-hooks` to add them.');
  }

  if (!outcome.bridgeExists) {
    console.log(`bridge:   not copied yet (${outcome.bridgeDest})`);
  } else if (outcome.bridgeStale) {
    console.log(`bridge:   ${outcome.bridgeDest} (STALE — re-run \`wmux setup-hooks\` to refresh)`);
  } else {
    console.log(`bridge:   ${outcome.bridgeDest} (up to date)`);
  }

  if (outcome.pluginAlsoInstalled && outcome.installedEvents.length > 0) {
    console.warn(
      'WARNING: the wmux-claude-integration plugin is ALSO installed. Each turn ' +
        'will fire double signals (hook-vs-hook is not deduped). Use only one — ' +
        'either uninstall the plugin or run `wmux setup-hooks --remove`.',
    );
  }
}

// ----- Dispatch -----------------------------------------------------------

export async function handleSetupHooks(args: string[], jsonMode: boolean): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
    return;
  }

  const remove = args.includes('--remove');
  const status = args.includes('--status');
  if (remove && status) {
    console.error('--remove and --status are mutually exclusive.');
    process.exit(1);
    return;
  }

  // Reject unknown arguments rather than silently falling through to a full
  // install — a typo like `--remov` must not WRITE hooks the user was trying
  // to delete.
  const unknown = args.filter((a) => a !== '--remove' && a !== '--status');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}. Run 'wmux setup-hooks --help' for usage.`);
    process.exit(1);
    return;
  }

  const paths = defaultPaths();

  if (status) {
    const outcome = statusHooks(paths);
    printStatus(outcome, jsonMode);
    // Scripted `wmux setup-hooks --status && …` must be able to gate on a
    // corrupted settings.json.
    if (outcome.settingsCorrupted) process.exit(1);
    return;
  }

  if (remove) {
    const outcome = removeHooks(paths);
    printRemove(outcome, jsonMode);
    if (!outcome.ok) process.exit(1);
    return;
  }

  const outcome = installHooks(paths);
  printInstall(outcome, jsonMode);
  if (!outcome.ok) process.exit(1);
}
