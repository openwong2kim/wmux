import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `wmux setup-statusline` — install the wmux usage statusline into Claude Code.
 *
 * Sets the `statusLine` command in Claude Code settings so the line under the
 * input box shows `<model> · <account> · ctx N% · 5h N% ↺ HH:MM · 7d N% ↺ Nh`
 * (the 7d remaining time reads `↺ NdNh` beyond 48h). The
 * numbers come from the JSON Claude Code pipes to the statusline on stdin
 * (`rate_limits`, `context_window`) — zero network, zero token spend; the
 * account label comes from local files (wmux accounts.json / the config dir's
 * .claude.json). Because the statusline process inherits CLAUDE_CONFIG_DIR
 * from its claude process, each pane shows the account IT actually runs on —
 * the multi-account-per-workspace case the global StatusBar widget can't
 * express.
 *
 * Targets: the default `~/.claude/settings.json` PLUS every registered claude
 * account's config dir (accounts.json) — CLAUDE_CONFIG_DIR partitions settings
 * entirely, so each account dir needs its own statusLine entry.
 *
 * Same durability strategy as `wmux setup-hooks`: the script is copied to the
 * stable `~/.wmux/hooks/wmux-statusline.mjs` (survives Squirrel app-x.y.z
 * updates), settings writes are atomic tmp+rename, corrupted settings.json
 * aborts that target, and a FOREIGN statusLine (user's own) is never clobbered.
 */

const HELP_TEXT = `
wmux setup-statusline — show per-account Claude usage in Claude Code's statusline

USAGE
  wmux setup-statusline [--remove | --status] [--json]

ACTIONS (mutually exclusive; default = install)
  (default)    Copy the statusline script to ~/.wmux/hooks/ and set statusLine
               in ~/.claude/settings.json and every registered claude account's
               settings.json. A non-wmux statusLine is left untouched (skipped).
  --remove     Remove only wmux-owned statusLine entries.
  --status     Report per-target install state.

GLOBAL FLAGS
  --json       Output raw JSON (useful for scripting).

NOTE
  Usage numbers come from Claude Code's own statusline stdin (rate_limits) —
  no extra API traffic. "usage —" simply means the session's first response
  hasn't arrived yet (or the account has no subscription rate limits).
`.trimStart();

/** Substring identifying a wmux-owned statusLine command. */
export const WMUX_STATUSLINE_MARKER = 'wmux-statusline.mjs';

export interface SetupStatuslinePaths {
  /** Settings files to edit: default dir first, then registered claude accounts. */
  targets: Array<{ label: string; settingsPath: string }>;
  /** Stable install location: `~/.wmux/hooks/wmux-statusline.mjs`. */
  scriptDest: string;
  /** Bundled script source, or null when it could not be located. */
  scriptSource: string | null;
}

/** Same upward-walk as setup-hooks findBridgeSourceFrom, for the statusline
 *  script (bundled next to the CLI / in cli-bundle / repo checkout). */
export function findStatuslineSourceFrom(startDir: string): string | null {
  const candidates = [
    'wmux-statusline.mjs',
    path.join('cli-bundle', 'wmux-statusline.mjs'),
    path.join('dist', 'cli-bundle', 'wmux-statusline.mjs'),
    path.join('integrations', 'claude', 'bin', 'wmux-statusline.mjs'),
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

interface AccountRowLoose {
  name?: unknown;
  vendor?: unknown;
  configDir?: unknown;
}

/** Best-effort read of registered claude accounts from `<wmuxDir>/accounts.json`.
 *  The CLI reads the file directly (main owns writes); absence / corruption
 *  degrades to the default target only. */
export function readClaudeAccountTargets(wmuxDir: string): Array<{ label: string; settingsPath: string }> {
  try {
    const raw = fs.readFileSync(path.join(wmuxDir, 'accounts.json'), 'utf8');
    const parsed = JSON.parse(raw) as { accounts?: unknown };
    if (!Array.isArray(parsed?.accounts)) return [];
    const out: Array<{ label: string; settingsPath: string }> = [];
    for (const a of parsed.accounts as AccountRowLoose[]) {
      if (!a || a.vendor !== 'claude') continue;
      if (typeof a.configDir !== 'string' || a.configDir.length === 0) continue;
      out.push({
        label: typeof a.name === 'string' && a.name ? a.name : a.configDir,
        settingsPath: path.join(a.configDir, 'settings.json'),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function defaultPaths(): SetupStatuslinePaths {
  const home = os.homedir();
  const targets = [
    { label: 'default (~/.claude)', settingsPath: path.join(home, '.claude', 'settings.json') },
    ...readClaudeAccountTargets(path.join(home, '.wmux')),
  ];
  // A registered account may point at ~/.claude itself — dedupe by settings
  // path. Case-fold only on Windows; case-sensitive filesystems treat
  // differently-cased paths as distinct dirs.
  const seen = new Set<string>();
  const deduped = targets.filter((t) => {
    const resolved = path.resolve(t.settingsPath);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    targets: deduped,
    scriptDest: path.join(home, '.wmux', 'hooks', 'wmux-statusline.mjs'),
    scriptSource: findStatuslineSourceFrom(__dirname),
  };
}

// ----- settings.json plumbing (mirrors setupHooks) -------------------------

function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

interface LoadResult {
  settings: Record<string, unknown>;
  exists: boolean;
  corrupted: boolean;
}

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

/** 'none' | 'wmux' | 'foreign' — what the target's statusLine currently is. */
export function classifyStatusLine(settings: Record<string, unknown>): 'none' | 'wmux' | 'foreign' {
  const sl = settings.statusLine;
  if (sl === undefined || sl === null) return 'none';
  if (sl && typeof sl === 'object' && !Array.isArray(sl)) {
    const cmd = (sl as Record<string, unknown>).command;
    if (typeof cmd === 'string' && cmd.includes(WMUX_STATUSLINE_MARKER)) return 'wmux';
  }
  return 'foreign';
}

function statuslineCommand(scriptDest: string): string {
  return `node "${scriptDest}"`;
}

// ----- Install / Remove / Status -------------------------------------------

export type TargetOutcome =
  | 'installed'      // statusLine written (fresh or refreshed)
  | 'skipped-foreign' // user has their own statusLine — untouched
  | 'skipped-corrupt' // settings.json unparseable — untouched
  | 'removed'
  | 'nothing';

export interface TargetReport {
  label: string;
  settingsPath: string;
  outcome: TargetOutcome;
}

export interface StatuslineOutcome {
  ok: boolean;
  scriptDest: string;
  scriptSource: string | null;
  scriptCopied: boolean;
  targets: TargetReport[];
  error: string | null;
}

export function installStatusline(paths: SetupStatuslinePaths): StatuslineOutcome {
  const base: StatuslineOutcome = {
    ok: false,
    scriptDest: paths.scriptDest,
    scriptSource: paths.scriptSource,
    scriptCopied: false,
    targets: [],
    error: null,
  };
  if (!paths.scriptSource) {
    return {
      ...base,
      error:
        'Could not locate the bundled wmux-statusline.mjs next to this CLI. Reinstall wmux or run from a repo checkout.',
    };
  }
  const destDir = path.dirname(paths.scriptDest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(paths.scriptSource, paths.scriptDest);

  const targets: TargetReport[] = [];
  for (const t of paths.targets) {
    const load = loadSettings(t.settingsPath);
    if (load.corrupted) {
      targets.push({ ...t, outcome: 'skipped-corrupt' });
      continue;
    }
    const kind = classifyStatusLine(load.settings);
    if (kind === 'foreign') {
      targets.push({ ...t, outcome: 'skipped-foreign' });
      continue;
    }
    load.settings.statusLine = { type: 'command', command: statuslineCommand(paths.scriptDest) };
    writeJsonAtomic(t.settingsPath, load.settings);
    targets.push({ ...t, outcome: 'installed' });
  }
  return { ...base, ok: true, scriptCopied: true, targets };
}

export function removeStatusline(paths: SetupStatuslinePaths): StatuslineOutcome {
  const targets: TargetReport[] = [];
  for (const t of paths.targets) {
    const load = loadSettings(t.settingsPath);
    if (!load.exists) {
      targets.push({ ...t, outcome: 'nothing' });
      continue;
    }
    if (load.corrupted) {
      targets.push({ ...t, outcome: 'skipped-corrupt' });
      continue;
    }
    if (classifyStatusLine(load.settings) !== 'wmux') {
      targets.push({ ...t, outcome: 'nothing' });
      continue;
    }
    delete load.settings.statusLine;
    writeJsonAtomic(t.settingsPath, load.settings);
    targets.push({ ...t, outcome: 'removed' });
  }
  return {
    ok: true,
    scriptDest: paths.scriptDest,
    scriptSource: paths.scriptSource,
    scriptCopied: false,
    targets,
    error: null,
  };
}

export interface StatuslineStatus {
  scriptDest: string;
  scriptExists: boolean;
  targets: Array<{ label: string; settingsPath: string; state: 'none' | 'wmux' | 'foreign' | 'corrupt' | 'missing' }>;
}

export function statusStatusline(paths: SetupStatuslinePaths): StatuslineStatus {
  return {
    scriptDest: paths.scriptDest,
    scriptExists: fs.existsSync(paths.scriptDest),
    targets: paths.targets.map((t) => {
      const load = loadSettings(t.settingsPath);
      if (!load.exists) return { ...t, state: 'missing' as const };
      if (load.corrupted) return { ...t, state: 'corrupt' as const };
      return { ...t, state: classifyStatusLine(load.settings) };
    }),
  };
}

// ----- Printing / dispatch --------------------------------------------------

function printOutcome(outcome: StatuslineOutcome, jsonMode: boolean, verb: string): void {
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (!outcome.ok) {
    if (outcome.error) console.error(outcome.error);
    return;
  }
  if (outcome.scriptCopied) console.log(`Copied statusline → ${outcome.scriptDest}`);
  for (const t of outcome.targets) {
    const note =
      t.outcome === 'installed' ? verb
      : t.outcome === 'removed' ? 'removed'
      : t.outcome === 'skipped-foreign' ? 'SKIPPED — a non-wmux statusLine is already set'
      : t.outcome === 'skipped-corrupt' ? 'SKIPPED — settings.json is not valid JSON'
      : 'nothing to do';
    console.log(`  ${t.label}: ${note} (${t.settingsPath})`);
  }
  console.log('Restart your Claude Code sessions for the statusline to take effect.');
}

function printStatus(status: StatuslineStatus, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(status.scriptExists
    ? `script:   ${status.scriptDest} (installed)`
    : `script:   not copied yet (${status.scriptDest})`);
  for (const t of status.targets) {
    console.log(`  ${t.label}: ${t.state} (${t.settingsPath})`);
  }
}

export async function handleSetupStatusline(args: string[], jsonMode: boolean): Promise<void> {
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
  const unknown = args.filter((a) => a !== '--remove' && a !== '--status');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}. Run 'wmux setup-statusline --help' for usage.`);
    process.exit(1);
    return;
  }

  const paths = defaultPaths();
  if (status) {
    printStatus(statusStatusline(paths), jsonMode);
    return;
  }
  const outcome = remove ? removeStatusline(paths) : installStatusline(paths);
  printOutcome(outcome, jsonMode, 'installed');
  if (!outcome.ok) process.exit(1);
}
