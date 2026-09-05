import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeJsonAtomic } from '../../shared/settingsFile';

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
wmux setup-hooks — install official CLI lifecycle integrations

USAGE
  wmux setup-hooks [--remove | --status] [--signals-only | --with-gate] [--json]

ACTIONS (mutually exclusive; default = install)
  (default)    Install or refresh Claude Code hooks, the Codex notify bridge,
               and the OpenCode lifecycle plugin. Existing foreign hooks,
               notify commands, and plugin files are never overwritten.
               Re-running KEEPS the hook profile already on disk.
  --remove     Remove only wmux-owned Claude hook entries (legacy behavior;
               Codex/OpenCode files and foreign configuration are untouched).
  --status     Report Claude, Codex, and OpenCode lifecycle integration status.

HOOK PROFILE (install only; mutually exclusive)
  --signals-only  Install the lifecycle signals and the approval card WITHOUT
                  the wide PreToolUse permission gate. Nothing wmux owns then
                  runs per tool call, so the agent pays no hook cost between
                  turns — at the price of remote approvals, which stop working
                  until the gate is added back.
  --with-gate     Install the full profile, gate included (the default for a
                  fresh install). Use this to undo --signals-only.

GLOBAL FLAGS
  --json       Output raw JSON (useful for scripting).
`.trimStart();

/** Claude Code hook events wmux owns at matcher:'' (mirrors hooks.json). These
 *  fire at turn boundaries, never per tool call.
 *
 *  `UserPromptSubmit` is the turn START, and it is what makes a pane's
 *  `running` state hook-driven instead of a byte-rate guess. It is compatible
 *  with the 2026-07-13 decision that removed the matcher:'' PostToolUse hook:
 *  that removal was about a ~110 ms node bridge PER TOOL CALL, and
 *  UserPromptSubmit fires exactly ONCE per turn — the same cost class as Stop,
 *  which has always been installed. */
const HOOK_EVENTS = ['Stop', 'SubagentStop', 'SessionStart', 'UserPromptSubmit'] as const;

/**
 * AskUserQuestion-scoped hook pair that drives the in-app approval card:
 *   PreToolUse  → card created  (agent.awaiting_input)
 *   PostToolUse → card expired   (agent.input_answered, on tool name alone)
 * Both are scoped to the AskUserQuestion matcher so they fire ONCE per
 * question, not on every tool call. The 2026-07-13 PostToolUse removal was
 * about a matcher:'' cost — a ~110ms node bridge per tool call feeding the
 * fleet "running" dot, which the daemon's byte-based ActivityMonitor now
 * drives for free. The approval card has no such replacement, so it gets its
 * own scoped pair. This closes #781: the plugin path (hooks.json) installed
 * these but the CLI (plugin-less) path did not, so the approval inbox silently
 * died for plugin-less users — `setup-hooks` even wiped a hand-registered
 * PreToolUse that pointed at our own bridge (isWmuxGroup match). */
const ASK_QUESTION_MATCHER = 'AskUserQuestion';
const ASK_QUESTION_HOOKS = [
  { event: 'PreToolUse', matcher: ASK_QUESTION_MATCHER },
  { event: 'PostToolUse', matcher: ASK_QUESTION_MATCHER },
] as const;

type HookEvent =
  | (typeof HOOK_EVENTS)[number]
  | (typeof ASK_QUESTION_HOOKS)[number]['event']
  | 'PreToolUse'; // #783 — permission gate adds a wide PreToolUse

/**
 * #783 — the permission-gate hook. A WIDE PreToolUse matcher (every tool) that
 * invokes the bridge with `--permission-gate`. The daemon decides gate vs
 * pass-through based on the `gatedTools` config slice, so this matcher never
 * needs editing — only the config does (`wmux gate --add/--remove`). Separate
 * from the AskUserQuestion PreToolUse above (different argv mode, different
 * signal kind, different resolution path — see CRITICAL 1 in the plan).
 */
const PERMISSION_GATE_SPEC = {
  event: 'PreToolUse' as const,
  matcher: '',
  extraArgs: '--permission-gate',
};

/** One wmux-owned hook entry in settings.json. */
interface HookSpec {
  event: HookEvent;
  matcher: string;
  extraArgs?: string;
}

/**
 * The turn-boundary signals plus the AskUserQuestion approval pair — every
 * wmux hook that does NOT fire per tool call. Stop/SubagentStop/SessionStart
 * are turn boundaries by definition, and the approval pair is scoped to a
 * single tool name.
 */
const SIGNAL_SPECS: readonly HookSpec[] = [
  ...HOOK_EVENTS.map((event) => ({ event, matcher: '' })),
  ...ASK_QUESTION_HOOKS,
];

/**
 * #970 — which hooks an install writes.
 *
 *   'full'         signals + the wide PreToolUse permission gate (default)
 *   'signals-only' signals alone; nothing wmux owns runs per tool call
 *
 * The gate hook is spawned on EVERY PreToolUse, and a node process spawn is
 * ~85 ms of the ~120 ms that costs before the bridge has read a byte of stdin
 * — so once the hook exists the cost cannot be optimised away, only not paid.
 * That matters because both things the wide hook does are useless without a
 * web surface: it resolves permission gates (armed only under
 * `wmux web --allow-input`, see WebTerminalServer.canResolveGates) and it
 * feeds `agent.tool_started` liveness (fanned out by emitAgentLiveness, a
 * no-op with no web server). A terminal-only operator pays the spawn for
 * neither. #435 already made this trade once, removing a wide PostToolUse for
 * the same per-tool-call reason; `gatedTools: []` cannot make it, because a
 * policy of "gate nothing" still spawns the process that asks.
 *
 * This is deliberately NOT a persisted setting: settings.json IS the state, so
 * the two can never drift. See `detectProfile`.
 */
export type HookProfile = 'full' | 'signals-only';

/** Every wmux-owned hook in settings.json as (event, matcher) specs — the
 *  single source `installHooks` writes and `statusHooks` checks against. */
const HOOK_SPECS: readonly HookSpec[] = [...SIGNAL_SPECS, PERMISSION_GATE_SPEC];

/** The specs a given profile installs. */
function specsFor(profile: HookProfile): readonly HookSpec[] {
  return profile === 'signals-only' ? SIGNAL_SPECS : HOOK_SPECS;
}

/** Stable identity of a spec — event plus argv tail, since the approval pair
 *  and the gate share the PreToolUse event and only the tail tells them apart. */
function specKey(spec: { event: HookEvent; extraArgs?: string }): string {
  return `${spec.event}${spec.extraArgs ? ` ${spec.extraArgs}` : ''}`;
}

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

/** `~/.claude/settings.json` — the only path a gate-presence check needs. */
function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function defaultPaths(): SetupHooksPaths {
  const home = os.homedir();
  return {
    settingsPath: defaultSettingsPath(),
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
 *   - `integrations/claude/bin/wmux-bridge.mjs` (live dev checkout; preferred
 *                                               over a potentially stale dist)
 *   - `dist/cli-bundle/wmux-bridge.mjs`        (repo build fallback)
 * Returns null when none exist, in which case install aborts with guidance.
 * 주의: 이 함수는 CLI뿐 아니라 hooksBridge.handler(메인 프로세스, 인앱 "hook 설치"
 * 버튼)에서도 호출된다 — cli-bundle/ 후보가 없으면 인앱 설치가 항상 실패한다(#489 후속).
 */
export function findBridgeSourceFrom(startDir: string): string | null {
  const candidates = [
    'wmux-bridge.mjs',
    path.join('cli-bundle', 'wmux-bridge.mjs'),
    // Prefer live checkout source over a potentially stale dist build.
    path.join('integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
    path.join('dist', 'cli-bundle', 'wmux-bridge.mjs'),
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

/** Build the command string for a hook event, referencing the stable bridge path. */
function bridgeCommand(bridgeDest: string, event: HookEvent, extraArgs?: string): string {
  // Mirror hooks.json shape: `node "<abs path>" <HookName>`. Quote the path so
  // spaces in the home directory don't break the command. #783: --permission-gate
  // appends an argv token that switches the bridge to the gate JSON mode.
  return `node "${bridgeDest}" ${event}${extraArgs ? ` ${extraArgs}` : ''}`;
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

/** True when a single hook leaf is a wmux-owned command. */
function isWmuxLeaf(leaf: unknown): boolean {
  return (
    !!leaf &&
    typeof leaf === 'object' &&
    typeof (leaf as HookLeaf).command === 'string' &&
    (leaf as HookLeaf).command.includes(WMUX_BRIDGE_MARKER)
  );
}

/**
 * True when a hook group contains a wmux-owned command leaf.
 *
 * Ownership is per GROUP here because that is what DETECTION needs: a group
 * carrying our leaf provides the spec no matter what else the user put beside
 * it. REMOVAL asks a different question and answers it per leaf — see
 * `stripWmuxHooks`.
 */
function isWmuxGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(isWmuxLeaf);
}

/**
 * True when a wmux-owned group has the effective scope required by a spec.
 * Claude Code treats an omitted matcher, `""`, and `"*"` as match-all.
 * `Stop` does not support matchers at all, so any string value is ignored.
 * Tool hooks stay stricter: the approval-card pair must name
 * `AskUserQuestion` exactly, rather than merely including it in a broader
 * scope that would reintroduce per-tool hook execution.
 */
function isEffectiveWmuxGroupForSpec(
  group: unknown,
  spec: { event: HookEvent; matcher: string; extraArgs?: string },
): boolean {
  if (!isWmuxGroup(group)) return false;
  const matcher = (group as HookGroup).matcher;
  if (matcher !== undefined && typeof matcher !== 'string') return false;

  // Two specs now share the PreToolUse event — the AskUserQuestion approval
  // pair and the wide `--permission-gate` group (#783) — so the event and the
  // matcher no longer identify a spec on their own. Compare the argv tail as
  // well: a group without `--permission-gate` can never satisfy the gate spec,
  // and the gate's own group can never stand in for the approval card.
  if (!hasArgvTail(group, spec)) return false;

  if (spec.matcher !== '') return matcher === spec.matcher;
  if (spec.event === 'Stop') return true;
  return matcher === undefined || matcher === '' || matcher === '*';
}

/** True when some wmux leaf in the group carries this spec's exact argv tail. */
function hasArgvTail(
  group: unknown,
  spec: { event: HookEvent; extraArgs?: string },
): boolean {
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  const tail = `${spec.event}${spec.extraArgs ? ` ${spec.extraArgs}` : ''}`;
  return hooks.some((h) => {
    if (!h || typeof h !== 'object') return false;
    const command = (h as HookLeaf).command;
    if (typeof command !== 'string' || !command.includes(WMUX_BRIDGE_MARKER)) return false;
    return command.trim().endsWith(tail);
  });
}

/**
 * The wmux specs currently registered in a settings object, keyed by specKey.
 * Shared by `installHooks` (to keep an existing profile) and `statusHooks`
 * (to report one), so the two can never disagree about what is installed.
 */
function installedSpecsIn(settings: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return found;
  const hooksMap = hooks as Record<string, unknown>;
  for (const spec of HOOK_SPECS) {
    const groups = hooksMap[spec.event];
    if (Array.isArray(groups) && groups.some((g) => isEffectiveWmuxGroupForSpec(g, spec))) {
      found.add(specKey(spec));
    }
  }
  return found;
}

/**
 * #970 — the profile a settings.json is already on. DERIVED, never stored: the
 * installed hooks ARE the profile, so no marker file can go stale against them,
 * and a bare re-run can never resurrect a gate hook the operator removed by
 * hand — which is the whole point for anyone who wants "wmux cannot participate
 * in permission decisions" to hold by construction.
 *
 * 'signals-only' requires EVERY signal spec present AND the gate absent. A
 * partial install (some signals missing) is a broken 'full' install to repair,
 * not a profile to preserve, so it reads as 'full' and a bare `wmux setup-hooks`
 * heals it. No wmux hooks at all also reads as 'full' — the fresh-install default.
 */
export function detectProfile(settings: Record<string, unknown>): HookProfile {
  const installed = installedSpecsIn(settings);
  const allSignals = SIGNAL_SPECS.every((spec) => installed.has(specKey(spec)));
  const gate = installed.has(specKey(PERMISSION_GATE_SPEC));
  return allSignals && !gate ? 'signals-only' : 'full';
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
 * Strip every wmux-owned hook LEAF from a settings.hooks map, dropping any
 * group, event array (and the `hooks` key itself) left empty. Returns the
 * number of leaves removed. Mutates `settings` in place. Used by both install
 * (clear-then-add) and remove.
 *
 * PRESERVES every foreign (non-wmux) hook, including one the user put INSIDE a
 * group of ours. Claude Code's schema lets a single matcher group hold several
 * command leaves, so "is this group wmux's?" and "is this command wmux's?" are
 * different questions: filtering whole groups answers the first and takes the
 * user's own leaf as collateral — on `--remove`, and on every reinstall, since
 * install is clear-then-add through this same function. Every group wmux
 * writes holds exactly one leaf and nothing else, so for wmux's own output the
 * two granularities are byte-identical; they diverge only in the hand-mixed
 * case, which is the one worth getting right. (#781: the report of
 * "setup-hooks wiped my PreToolUse" was a group whose command pointed at
 * wmux-bridge.mjs itself, which is correctly wmux-owned and thus refreshed,
 * not a foreign hook destroyed.)
 */
function stripWmuxHooks(settings: Record<string, unknown>): number {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  const hooksMap = hooks as Record<string, unknown>;
  let removed = 0;
  for (const event of Object.keys(hooksMap)) {
    const groups = hooksMap[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isWmuxGroup(group)) {
        kept.push(group);
        continue;
      }
      const leaves = (group as HookGroup).hooks as unknown[];
      const foreign = leaves.filter((leaf) => !isWmuxLeaf(leaf));
      removed += leaves.length - foreign.length;
      // Ours alone: the group goes with the leaf, exactly as before.
      if (foreign.length === 0) continue;
      // Hand-mixed: keep the group, the matcher, and the user's leaves.
      (group as HookGroup).hooks = foreign as HookLeaf[];
      kept.push(group);
    }
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
  /**
   * #970 — the hook profile this run installed. Absent an explicit
   * `--signals-only`/`--with-gate`, it is whatever settings.json was already
   * on, so a refresh never silently changes it.
   */
  profile: HookProfile;
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

/**
 * @param requestedProfile explicit `--signals-only` / `--with-gate`. Omitted
 *   (a bare `wmux setup-hooks`) means KEEP whatever profile settings.json is
 *   already on — a refresh that quietly re-added the gate would undo the
 *   operator's choice on the next app update, which is exactly the stale-script
 *   failure `refreshHookBridge` exists to avoid.
 */
export function installHooks(
  paths: SetupHooksPaths,
  requestedProfile?: HookProfile,
): InstallOutcome {
  const base: InstallOutcome = {
    ok: false,
    settingsPath: paths.settingsPath,
    bridgeDest: paths.bridgeDest,
    bridgeSource: paths.bridgeSource,
    events: [],
    profile: requestedProfile ?? 'full',
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
  // Resolved BEFORE any mutation — `stripWmuxHooks` below erases the very
  // entries the derivation reads.
  const profile: HookProfile = requestedProfile ?? detectProfile(settings);
  const specs = specsFor(profile);

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
    return {
      ...base,
      ok: true,
      pluginDetected: true,
      removedForPlugin,
      // The plugin's hooks.json is a fixed profile that includes the gate, and
      // settings.json entries would only double the signals. Say so instead of
      // reporting a signals-only install that did not happen (#970).
      profile: 'full',
      ...(requestedProfile === 'signals-only'
        ? {
            warning:
              '--signals-only had no effect: the wmux-claude-integration plugin owns these ' +
              'hooks and its profile includes the permission gate. Disable or uninstall the ' +
              'plugin and re-run to install the signals-only profile from settings.json.',
          }
        : {}),
    };
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

  for (const spec of specs) {
    const group: HookGroup = {
      matcher: spec.matcher,
      hooks: [{ type: 'command', command: bridgeCommand(paths.bridgeDest, spec.event, spec.extraArgs) }],
    };
    const existing = hooks[spec.event];
    hooks[spec.event] = Array.isArray(existing) ? [...existing, group] : [group];
  }
  settings.hooks = hooks;

  // 4. Atomic write.
  writeJsonAtomic(paths.settingsPath, settings);

  return {
    ...base,
    ok: true,
    bridgeCopied: true,
    profile,
    events: specs.map((s) => s.event),
  };
}

// ----- Boot-time script refresh -------------------------------------------

/** What a boot-time bridge refresh did — mirrors setupStatusline's RefreshOutcome. */
export type BridgeRefreshOutcome =
  | 'refreshed'     // installed bridge was stale OR missing; the bundled one (re)written
  | 'up-to-date'    // byte-identical, nothing written
  | 'not-installed' // no wmux hooks reference the stable bridge — nothing to refresh
  | 'no-source'     // bundled bridge not locatable (broken install / odd layout)
  | 'failed';       // read/copy error — the old bridge keeps working, just stale

/** True when settings.json has at least one wmux-owned hook group referencing
 *  the stable bridge — i.e. the plugin-LESS install this refresh owns. */
function settingsReferenceBridge(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return Object.values(hooks as Record<string, unknown>).some(
    (groups) => Array.isArray(groups) && groups.some((g) => isWmuxGroup(g)),
  );
}

/**
 * Bring `~/.wmux/hooks/wmux-bridge.mjs` up to the bundled version at boot.
 *
 * Same stale-by-construction problem as the statusline script (see
 * setupStatusline.refreshStatuslineScript): the bridge is copied to a stable
 * path so it survives Squirrel's `app-x.y.z` swap, which is exactly why an app
 * update never refreshed it — the user had to re-run `wmux setup-hooks` by hand,
 * and a stale bridge silently keeps its old behavior (a real case: the log
 * rotation + activity-stamp throttle from the "30+ sessions" scaling fix never
 * reached an already-installed bridge, so its bridge.log grew without bound).
 *
 * Scope is deliberately narrow — this owns ONLY the plugin-LESS copy under
 * `~/.wmux/hooks/`, and only when settings.json actually references it. It does
 * NOT touch the marketplace plugin's own bridge under
 * `~/.claude/plugins/cache/…` — that copy is versioned and updated by Claude
 * Code's plugin system, not by wmux. And like the statusline refresh it never
 * writes settings.json, so it cannot enroll a user or resurrect a hook they
 * removed: no wmux hook groups → 'not-installed', nothing happens.
 *
 * The settings reference is checked BEFORE the file is read, so a hook still
 * pointing at a bridge that has since been deleted is REPAIRED rather than
 * written off as uninstalled — otherwise every configured hook would keep
 * targeting a nonexistent file and this reconcile would never fix it.
 *
 * tmp+rename because the bridge is spawned on every Stop/SubagentStop/etc.; a
 * plain copy could hand a half-written script to a hook firing mid-copy. The
 * tmp name carries the pid so two instances racing at boot can't interleave.
 */
export function refreshHookBridge(paths: SetupHooksPaths): BridgeRefreshOutcome {
  if (!paths.bridgeSource) return 'no-source';
  try {
    const load = loadSettings(paths.settingsPath);
    if (load.corrupted || !settingsReferenceBridge(load.settings)) return 'not-installed';
    const source = fs.readFileSync(paths.bridgeSource);
    // A missing destination is a repair case, not "up to date" — read it
    // defensively (ENOENT → force a write) rather than gating on existsSync.
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(paths.bridgeDest);
    } catch {
      current = null;
    }
    if (current && source.equals(current)) return 'up-to-date';
    const destDir = path.dirname(paths.bridgeDest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const tmp = paths.bridgeDest + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, source);
    fs.renameSync(tmp, paths.bridgeDest);
    return 'refreshed';
  } catch {
    return 'failed';
  }
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

/** Feature-oriented status entry: what the user cares about ("does the approval
 *  card work?"), not which hook event name is registered. */
export interface HookFeatureStatus {
  /** 'ok' when the hook(s) backing this feature are installed, 'off' otherwise. */
  state: 'ok' | 'off';
  /** Human-readable explanation; includes the fix command when state is 'off'. */
  detail: string;
}

export interface StatusOutcome {
  settingsPath: string;
  settingsExists: boolean;
  settingsCorrupted: boolean;
  /** wmux hook events currently present in settings.json. */
  installedEvents: HookEvent[];
  /**
   * #970 — the hook profile settings.json is on, derived from the installed
   * specs. 'signals-only' means the wide PreToolUse gate was deliberately not
   * installed, so `features.permissionGate` being 'off' is a configuration and
   * not a defect.
   */
  profile: HookProfile;
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
  /**
   * Feature-oriented status — the primary surface for users, who ask "does the
   * approval card work?" not "is PreToolUse registered?". `installedEvents`
   * remains the effective settings.json view for scripts; `features` also
   * accounts for hooks supplied by an active marketplace plugin.
   * `permissionGate` reports the wide PreToolUse gate hook (#783); it shares an
   * event with the approval card, so features are resolved per SPEC, not per
   * event.
   */
  features: {
    conversationRead: HookFeatureStatus;
    approvalCard: HookFeatureStatus;
    turnStart: HookFeatureStatus;
    turnEnd: HookFeatureStatus;
    permissionGate: HookFeatureStatus;
  };
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
  const pluginActive =
    !load.corrupted &&
    detectPluginViaManifest(paths.settingsPath) &&
    !isPluginExplicitlyDisabled(load.settings);

  // PreToolUse now carries TWO specs (the AskUserQuestion approval hook and the
  // wide permission gate), so `installedEvents` — an event list — can no longer
  // tell the features apart: the gate hook alone would report the approval card
  // as healthy. Features read this spec-level set instead.
  const installedSpecs = load.corrupted ? new Set<string>() : installedSpecsIn(load.settings);
  const installedEvents: HookEvent[] = [];
  for (const spec of HOOK_SPECS) {
    // HOOK_SPECS carries PreToolUse twice (approval pair + gate), so dedup.
    if (installedSpecs.has(specKey(spec)) && !installedEvents.includes(spec.event)) {
      installedEvents.push(spec.event);
    }
  }
  // #970 — a corrupt settings file has no derivable profile; report the default
  // rather than inventing a 'signals-only' the operator never chose.
  const profile: HookProfile = load.corrupted ? 'full' : detectProfile(load.settings);

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

  // Feature-oriented view derived from effective settings hooks plus the
  // authoritative active-plugin signal. The bundled plugin supplies
  // SessionStart, Stop/SubagentStop, and the approval-card lifecycle: its
  // PreToolUse is AskUserQuestion-scoped, while its broad PostToolUse bridge
  // promotes only AskUserQuestion completion to agent.input_answered.
  // The permission gate (#783) is its own spec on the same event, reported
  // separately below.
  const has = (e: HookEvent): boolean => installedEvents.includes(e);
  /** Spec-level presence — the approval pair and the gate share PreToolUse. */
  const hasSpec = (event: HookEvent, extraArgs?: string): boolean =>
    installedSpecs.has(specKey({ event, ...(extraArgs ? { extraArgs } : {}) }));
  const FIX = 'wmux setup-hooks';
  const featureStatus = (
    pluginSupplies: boolean,
    manualHooksSupply: boolean,
    okDetail: string,
    offDetail: string,
  ): HookFeatureStatus => {
    if (pluginSupplies) {
      return {
        state: 'ok',
        detail: `plugin-managed by ${WMUX_PLUGIN_MARKER}: ${okDetail}`,
      };
    }
    return manualHooksSupply
      ? { state: 'ok', detail: okDetail }
      : { state: 'off', detail: offDetail };
  };
  const pluginFeatures = {
    conversationRead: pluginActive,
    approvalCard: pluginActive,
    // Plugin >= 0.4.0 registers UserPromptSubmit. An older installed plugin is
    // indistinguishable here (the manifest scan reads no version), which is the
    // same best-effort contract every other plugin-managed row already has —
    // `/plugin update` is the fix, and the detail line says which hook is meant.
    turnStart: pluginActive,
    turnEnd: pluginActive,
  };
  const features = {
    conversationRead: featureStatus(
      pluginFeatures.conversationRead,
      has('SessionStart'),
      'SessionStart → transcript binding on session start',
      `SessionStart missing → run \`${FIX}\``,
    ),
    approvalCard: featureStatus(
      pluginFeatures.approvalCard,
      // The AskUserQuestion-scoped pair specifically — the wide gate hook lives
      // on the same event and must never stand in for it.
      hasSpec('PreToolUse') && hasSpec('PostToolUse'),
      'PreToolUse + PostToolUse (AskUserQuestion) → card create + expire',
      `PreToolUse/PostToolUse:AskUserQuestion missing → run \`${FIX}\``,
    ),
    // Turn START — the hook that makes the pane's `running` state precise
    // instead of a byte-rate guess. Without it the pane still works, it just
    // falls back to the activity heuristic (amber only after enough output).
    turnStart: featureStatus(
      pluginFeatures.turnStart,
      has('UserPromptSubmit'),
      'UserPromptSubmit → pane turns running the moment a prompt is submitted',
      `UserPromptSubmit missing → run \`${FIX}\``,
    ),
    turnEnd: featureStatus(
      pluginFeatures.turnEnd,
      has('Stop') && has('SubagentStop'),
      'Stop + SubagentStop → turn-end nudge',
      `Stop/SubagentStop missing → run \`${FIX}\``,
    ),
    // #783 — the gate ships with its own wide PreToolUse hook, so this is a
    // real install state now, not a placeholder. It arms only while an
    // answering surface is up (`wmux web`); the detail says so, because a hook
    // that is installed and dormant would otherwise read as broken.
    // #970 — and an ABSENT gate is now two states, not one. On the signals-only
    // profile it is the operator's choice, so the detail names the profile and
    // offers the way back rather than calling it missing. The old copy encoded
    // "the gate is required" as a string — an answer to a design question that
    // had not been asked yet.
    permissionGate: featureStatus(
      pluginActive,
      hasSpec('PreToolUse', PERMISSION_GATE_SPEC.extraArgs),
      'PreToolUse (all tools) → remote approval while `wmux web` is running',
      profile === 'signals-only'
        ? 'signals-only profile — no wmux hook runs per tool call; ' +
          `\`${FIX} --with-gate\` to enable remote approvals`
        : `PreToolUse permission gate missing → run \`${FIX}\``,
    ),
  };

  return {
    settingsPath: paths.settingsPath,
    settingsExists: load.exists,
    settingsCorrupted: load.corrupted,
    installedEvents,
    profile,
    bridgeDest: paths.bridgeDest,
    bridgeExists,
    bridgeSource: paths.bridgeSource,
    bridgeStale,
    pluginAlsoInstalled: detectPluginInstalled(paths.settingsPath),
    features,
  };
}

/**
 * #970 — is the wide PreToolUse permission gate hook actually installed?
 *
 * `wmux web --allow-input` is the only thing that ARMS the gate, which makes it
 * the only place that can catch the signals-only mismatch. Without the hook no
 * tool call ever reaches the broker, so the phone simply never rings: there is
 * no error, no log line, and no timeout anywhere to notice — the failure is
 * silent, which is strictly worse than a loud one.
 *
 * Deliberately cheaper than `statusHooks`: a settings read plus the plugin
 * manifest, with no `plugins/` directory walk, no bridge byte-compare, and no
 * `findBridgeSource` upward walk — it takes the settings path alone rather than
 * a full `SetupHooksPaths`, because that is all it reads. This runs on a
 * user-facing startup path.
 *
 * A corrupt settings.json returns FALSE. We cannot prove the gate is there, and
 * a false "armed" reading is exactly the outcome this guard exists to prevent.
 */
export function isPermissionGateInstalled(settingsPath: string = defaultSettingsPath()): boolean {
  const load = loadSettings(settingsPath);
  if (load.corrupted) return false;
  // An active marketplace plugin supplies the gate from its own hooks.json,
  // where it is not optional — settings.json will be empty of wmux hooks then.
  if (detectPluginViaManifest(settingsPath) && !isPluginExplicitlyDisabled(load.settings)) {
    return true;
  }
  return installedSpecsIn(load.settings).has(specKey(PERMISSION_GATE_SPEC));
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
    if (outcome.warning) console.warn(outcome.warning);
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
  console.log(
    outcome.profile === 'signals-only'
      ? 'Profile: signals-only — no wmux hook runs per tool call. Remote approvals are OFF; '
        + 'run `wmux setup-hooks --with-gate` to enable them.'
      : 'Profile: full — the PreToolUse permission gate is installed; it arms under '
        + '`wmux web --allow-input`.',
  );
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

  // Feature table first — users ask "does the approval card work?", not "which
  // hook event names are registered?". Each row shows state + how to fix it on
  // one line (#781).
  const featureRows: Array<[string, HookFeatureStatus]> = [
    ['conversation read', outcome.features.conversationRead],
    ['approval card', outcome.features.approvalCard],
    ['turn-start signal', outcome.features.turnStart],
    ['turn-end signal', outcome.features.turnEnd],
    ['permission gate', outcome.features.permissionGate],
  ];
  for (const [label, f] of featureRows) {
    const tag = f.state === 'ok' ? 'OK ' : 'OFF';
    console.log(`${label.padEnd(18)} ${tag}  ${f.detail}`);
  }

  console.log('');
  if (outcome.settingsCorrupted) {
    console.log(`settings: ${outcome.settingsPath} (UNPARSEABLE — fix before installing)`);
  } else if (outcome.installedEvents.length > 0) {
    console.log(
      `settings: ${outcome.settingsPath} (profile: ${outcome.profile}; ` +
        `hooks: ${outcome.installedEvents.join(', ')})`,
    );
  } else {
    console.log(`settings: ${outcome.settingsPath} (wmux hooks NOT installed)`);
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

// ----- Aggregate lifecycle integration printing ----------------------------

interface PrintableAssetStatus {
  sourcePath: string | null;
  destinationPath: string;
  state: string;
  error: string | null;
}

function printAssetStatus(label: string, asset: PrintableAssetStatus): void {
  switch (asset.state) {
    case 'current':
      console.log(`${label}: ${asset.destinationPath} (up to date)`);
      break;
    case 'missing':
      console.log(`${label}: NOT installed (${asset.destinationPath})`);
      break;
    case 'stale':
      console.log(`${label}: ${asset.destinationPath} (STALE — re-run \`wmux setup-hooks\`)`);
      break;
    case 'foreign':
      console.warn(`${label}: CONFLICT — ${asset.destinationPath} is not wmux-owned; left untouched`);
      break;
    case 'source-missing':
      console.log(`${label}: bundled source unavailable; reinstall or rebuild wmux`);
      break;
    default:
      console.log(`${label}: ERROR${asset.error ? ` — ${asset.error}` : ''}`);
      break;
  }
}

function printAssetInstall(
  label: string,
  asset: PrintableAssetStatus & { action: 'none' | 'installed' | 'refreshed' },
): void {
  if (asset.action === 'installed') {
    console.log(`${label}: installed → ${asset.destinationPath}`);
  } else if (asset.action === 'refreshed') {
    console.log(`${label}: refreshed → ${asset.destinationPath}`);
  } else {
    printAssetStatus(label, asset);
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

  // #970 — profile selection. Omitting both keeps whatever profile is already
  // installed, so a refresh (or the in-app "install hooks" button) never
  // silently re-adds a gate the operator removed.
  const signalsOnly = args.includes('--signals-only');
  const withGate = args.includes('--with-gate');
  if (signalsOnly && withGate) {
    console.error('--signals-only and --with-gate are mutually exclusive.');
    process.exit(1);
    return;
  }
  // Rejected rather than ignored: `--status --signals-only` reads as "report
  // the signals-only profile", and silently reporting the installed one
  // instead would answer a question the user did not ask.
  if ((signalsOnly || withGate) && (remove || status)) {
    console.error('--signals-only and --with-gate apply to install only; drop --remove/--status.');
    process.exit(1);
    return;
  }
  const requestedProfile: HookProfile | undefined = signalsOnly
    ? 'signals-only'
    : withGate
      ? 'full'
      : undefined;

  // Reject unknown arguments rather than silently falling through to a full
  // install — a typo like `--remov` must not WRITE hooks the user was trying
  // to delete.
  const unknown = args.filter(
    (a) => a !== '--remove' && a !== '--status' && a !== '--signals-only' && a !== '--with-gate',
  );
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}. Run 'wmux setup-hooks --help' for usage.`);
    process.exit(1);
    return;
  }

  const paths = defaultPaths();

  // Preserve the historical --remove contract: it only edits Claude's
  // settings.json and never deletes shared scripts or another CLI's config.
  if (remove) {
    const outcome = removeHooks(paths);
    printRemove(outcome, jsonMode);
    if (!outcome.ok) process.exit(1);
    return;
  }

  const lifecycle = await import('../../shared/lifecycleIntegrations');
  const lifecyclePaths = lifecycle.resolveLifecycleIntegrationPaths(os.homedir(), __dirname);

  if (status) {
    const claude = statusHooks(paths);
    const integrations = lifecycle.statusLifecycleIntegrations(lifecyclePaths);
    // Preserve the legacy Claude-only root fields for scripts while exposing
    // the richer per-integration objects alongside them.
    const outcome = { ...claude, claude, ...integrations };
    if (jsonMode) {
      console.log(JSON.stringify(outcome, null, 2));
    } else {
      printStatus(claude, false);
      printAssetStatus('codex bridge', integrations.codexBridge);
      if (!integrations.codexNotify.configExists) {
        console.log(`codex notify: Codex config not found (${integrations.codexNotify.configPath})`);
      } else if (integrations.codexNotify.state === 'wmux') {
        console.log(`codex notify: registered → ${integrations.codexNotify.path}`);
      } else if (integrations.codexNotify.state === 'stale') {
        console.warn(
          `codex notify: STALE (${integrations.codexNotify.path ?? integrations.codexNotify.configPath}); ` +
          're-run `wmux setup-hooks`',
        );
      } else if (integrations.codexNotify.state === 'foreign') {
        console.warn(`codex notify: CONFLICT in ${integrations.codexNotify.configPath}; foreign notify left untouched`);
      } else if (integrations.codexNotify.state === 'malformed') {
        console.warn(`codex notify: MALFORMED config left untouched (${integrations.codexNotify.configPath})`);
      } else {
        console.log(`codex notify: NOT registered (${integrations.codexNotify.configPath})`);
      }
      printAssetStatus('opencode plugin', integrations.opencodePlugin);
    }
    // Keep the existing scripted contract: status is non-zero only when the
    // Claude settings file is corrupt, not merely because an optional CLI is
    // absent or a user-owned integration occupies its slot.
    if (claude.settingsCorrupted) process.exit(1);
    return;
  }

  // Run each integration independently so a corrupt Claude settings file does
  // not prevent safe Codex/OpenCode installation (and vice versa).
  const claude = installHooks(paths, requestedProfile);
  const integrations = lifecycle.installLifecycleIntegrations(lifecyclePaths);
  const outcome = {
    ...claude,
    ...integrations,
    ok: claude.ok && integrations.ok,
    claude,
  };
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
  } else {
    printInstall(claude, false);
    printAssetInstall('codex bridge', integrations.codexBridge);
    if (!integrations.codexNotify) {
      console.warn('codex notify: not registered because the bridge could not be installed safely');
    } else if (integrations.codexNotify.skipped === 'absent') {
      console.log(`codex notify: Codex config not found (${integrations.codexNotify.configPath})`);
    } else if (integrations.codexNotify.skipped === 'foreign') {
      console.warn(`codex notify: CONFLICT in ${integrations.codexNotify.configPath}; foreign notify left untouched`);
    } else if (integrations.codexNotify.skipped === 'malformed') {
      console.warn(`codex notify: malformed config left untouched (${integrations.codexNotify.configPath})`);
    } else if (integrations.codexNotify.wrote) {
      console.log(`codex notify: registered in ${integrations.codexNotify.configPath}`);
    } else {
      console.log(`codex notify: already registered in ${integrations.codexNotify.configPath}`);
    }
    printAssetInstall('opencode plugin', integrations.opencodePlugin);
    if (integrations.opencodePlugin.action !== 'none') {
      console.log('Restart existing OpenCode sessions so they load the wmux plugin.');
    }
  }
  if (!outcome.ok) process.exit(1);
}
