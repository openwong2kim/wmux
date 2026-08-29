import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StatuslineTargetOutcome } from '../../shared/statuslineOutcome';

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
  --remove     Remove only wmux-owned statusLine entries. A statusLine that
               --force replaced earlier is put back rather than left empty.
  --status     Report per-target install state.

INSTALL FLAGS
  --force      Replace a non-wmux statusLine instead of skipping it. Without
               this, a settings.json that already has someone else's statusLine
               is reported as SKIPPED and nothing is written.

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

/** The command string of a FOREIGN statusLine, for showing the operator what a
 *  forced install would overwrite. Null unless the entry is foreign and its
 *  command is a plain string — consent to replace something you cannot see is
 *  not consent (#1102 eng review, D2). */
export function foreignStatusLineCommand(settings: Record<string, unknown>): string | null {
  if (classifyStatusLine(settings) !== 'foreign') return null;
  const sl = settings.statusLine;
  if (!sl || typeof sl !== 'object' || Array.isArray(sl)) return null;
  const cmd = (sl as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd.length > 0 ? cmd : null;
}

function statuslineCommand(scriptDest: string): string {
  return `node "${scriptDest}"`;
}

// ----- Replaced-entry ledger ------------------------------------------------
//
// A forced install overwrites someone else's statusLine, and the command string
// it overwrites is the only copy that exists — the operator who no longer
// remembers how they invoked ccusage cannot get it back. So the previous value
// is written aside first, and `--remove` puts it back instead of leaving the
// pane with no statusline at all: after Replace → Remove you are where you
// started, not somewhere worse (#1102 eng review, D1).
//
// It lives next to the installed script (~/.wmux/hooks/) for the same reason
// the script does — that path survives Squirrel's app-x.y.z swap — and NOT in
// the user's own config dir, which wmux has no business littering.

const REPLACED_LEDGER_BASENAME = 'statusline-replaced.json';

function replacedLedgerPath(paths: SetupStatuslinePaths): string {
  return path.join(path.dirname(paths.scriptDest), REPLACED_LEDGER_BASENAME);
}

/** Same case-folding as the target dedupe: Windows paths differing only in case
 *  are one file, POSIX paths are not. */
function ledgerKey(settingsPath: string): string {
  const resolved = path.resolve(settingsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface ReplacedEntry {
  /** The whole original `statusLine` value, so a restore reproduces it exactly
   *  rather than rebuilding a command into a guessed shape. */
  statusLine: unknown;
  at: string;
}

function readReplacedLedger(paths: SetupStatuslinePaths): Record<string, ReplacedEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(replacedLedgerPath(paths), 'utf8'), safeReviver) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, ReplacedEntry>;
  } catch {
    return {};
  }
}

/** Best-effort: a ledger we cannot write must not fail the install the operator
 *  asked for — it costs them the undo, not the feature. */
function writeReplacedLedger(paths: SetupStatuslinePaths, ledger: Record<string, ReplacedEntry>): void {
  try {
    writeJsonAtomic(replacedLedgerPath(paths), ledger);
  } catch {
    /* ignore */
  }
}

// ----- Install / Remove / Status -------------------------------------------

export type TargetOutcome = StatuslineTargetOutcome;

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

export interface InstallStatuslineOptions {
  /** Overwrite a foreign (non-wmux) statusLine. Off by default: wmux never
   *  clobbers someone else's config without the human saying so. The UI asks
   *  for a second, explicit click before it sets this. */
  force?: boolean;
}

export function installStatusline(
  paths: SetupStatuslinePaths,
  opts: InstallStatuslineOptions = {},
): StatuslineOutcome {
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
  let ledger: Record<string, ReplacedEntry> | null = null;
  for (const t of paths.targets) {
    const load = loadSettings(t.settingsPath);
    if (load.corrupted) {
      targets.push({ ...t, outcome: 'skipped-corrupt' });
      continue;
    }
    const kind = classifyStatusLine(load.settings);
    if (kind === 'foreign' && !opts.force) {
      targets.push({ ...t, outcome: 'skipped-foreign' });
      continue;
    }
    if (kind === 'foreign') {
      // Read lazily: the ledger only matters on the forced path, which is rare.
      ledger ??= readReplacedLedger(paths);
      ledger[ledgerKey(t.settingsPath)] = {
        statusLine: load.settings.statusLine,
        at: new Date().toISOString(),
      };
    }
    load.settings.statusLine = { type: 'command', command: statuslineCommand(paths.scriptDest) };
    writeJsonAtomic(t.settingsPath, load.settings);
    targets.push({ ...t, outcome: kind === 'foreign' ? 'replaced' : 'installed' });
  }
  if (ledger) writeReplacedLedger(paths, ledger);
  return { ...base, ok: true, scriptCopied: true, targets };
}

/** What a boot-time script refresh did — see refreshStatuslineScript. */
export type RefreshOutcome =
  | 'refreshed'     // installed script was stale OR missing; the bundled one (re)written
  | 'up-to-date'    // byte-identical, nothing written
  | 'not-installed' // no wmux-owned statusLine — the user never opted in
  | 'no-source'     // bundled script not locatable (broken install / odd layout)
  | 'failed';       // read/copy error — the old script keeps working, just stale

/**
 * Bring `~/.wmux/hooks/wmux-statusline.mjs` up to the bundled version.
 *
 * The script is copied out to a stable path so it survives Squirrel's
 * `app-x.y.z` swap — which also means an app update alone never refreshed it:
 * the user had to re-run `wmux setup-statusline` by hand. A stale script fails
 * silently by construction — no error, just a line that quietly stopped
 * matching what this version renders or what Claude Code now sends on stdin.
 *
 * Safe to run at boot because it does NOT enroll anyone: it touches nothing
 * unless a wmux-owned `statusLine` is already installed, and it never writes
 * settings.json. That keeps the "never auto-run at boot" constraint (owner
 * decision 2026-07-17) intact — that rule is about opting a user IN, not about
 * keeping a file they already opted into correct.
 *
 * Ownership is checked BEFORE the file is read, so a `statusLine` that still
 * points at a script which has since been deleted (manual cleanup, a partial
 * reinstall) is REPAIRED, not written off as uninstalled — otherwise Claude
 * Code would keep invoking a nonexistent script every tick and this boot
 * reconcile, the very thing meant to heal it, would skip it forever.
 *
 * The write is tmp+rename because the statusline runs at input-box frequency;
 * a plain copy could hand a half-written script to a tick landing mid-copy. The
 * tmp name carries the pid so two instances racing at boot (a Squirrel swap can
 * briefly overlap old and new) can't interleave writes into one temp file.
 */
export function refreshStatuslineScript(paths: SetupStatuslinePaths): RefreshOutcome {
  if (!paths.scriptSource) return 'no-source';
  try {
    const owned = paths.targets.some((t) => {
      const load = loadSettings(t.settingsPath);
      return !load.corrupted && classifyStatusLine(load.settings) === 'wmux';
    });
    if (!owned) return 'not-installed';
    const source = fs.readFileSync(paths.scriptSource);
    // A missing destination is a repair case, not "up to date" — read it
    // defensively (ENOENT → force a write) rather than gating on existsSync.
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(paths.scriptDest);
    } catch {
      current = null;
    }
    if (current && source.equals(current)) return 'up-to-date';
    const destDir = path.dirname(paths.scriptDest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const tmp = paths.scriptDest + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, source);
    fs.renameSync(tmp, paths.scriptDest);
    return 'refreshed';
  } catch {
    return 'failed';
  }
}

export function removeStatusline(paths: SetupStatuslinePaths): StatuslineOutcome {
  const targets: TargetReport[] = [];
  const ledger = readReplacedLedger(paths);
  let ledgerDirty = false;
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
    // An entry we replaced goes back the way it was; anything else just goes.
    // Restoring only over a wmux-owned entry means a statusLine the user has
    // since changed by hand is never clobbered by our undo.
    const key = ledgerKey(t.settingsPath);
    const saved = ledger[key];
    if (saved && saved.statusLine !== undefined) {
      load.settings.statusLine = saved.statusLine;
      writeJsonAtomic(t.settingsPath, load.settings);
      delete ledger[key];
      ledgerDirty = true;
      targets.push({ ...t, outcome: 'restored' });
      continue;
    }
    delete load.settings.statusLine;
    writeJsonAtomic(t.settingsPath, load.settings);
    targets.push({ ...t, outcome: 'removed' });
  }
  if (ledgerDirty) writeReplacedLedger(paths, ledger);
  return {
    ok: true,
    scriptDest: paths.scriptDest,
    scriptSource: paths.scriptSource,
    scriptCopied: false,
    targets,
    error: null,
  };
}

export interface StatuslineTargetStatus {
  label: string;
  settingsPath: string;
  state: 'none' | 'wmux' | 'foreign' | 'corrupt' | 'missing';
  /** Present only for `foreign`: the command the operator would be replacing. */
  foreignCommand?: string;
}

export interface StatuslineStatus {
  scriptDest: string;
  scriptExists: boolean;
  targets: StatuslineTargetStatus[];
}

export function statusStatusline(paths: SetupStatuslinePaths): StatuslineStatus {
  return {
    scriptDest: paths.scriptDest,
    scriptExists: fs.existsSync(paths.scriptDest),
    targets: paths.targets.map((t): StatuslineTargetStatus => {
      const load = loadSettings(t.settingsPath);
      if (!load.exists) return { ...t, state: 'missing' };
      if (load.corrupted) return { ...t, state: 'corrupt' };
      const state = classifyStatusLine(load.settings);
      if (state !== 'foreign') return { ...t, state };
      const foreignCommand = foreignStatusLineCommand(load.settings);
      return foreignCommand ? { ...t, state, foreignCommand } : { ...t, state };
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
      : t.outcome === 'replaced' ? 'replaced a non-wmux statusLine'
      : t.outcome === 'removed' ? 'removed'
      : t.outcome === 'restored' ? 'removed — put your previous statusLine back'
      : t.outcome === 'skipped-foreign' ? 'SKIPPED — a non-wmux statusLine is already set (re-run with --force to replace it)'
      : t.outcome === 'skipped-corrupt' ? 'SKIPPED — settings.json is not valid JSON'
      : 'nothing to do';
    console.log(`  ${t.label}: ${note} (${t.settingsPath})`);
  }
  if (outcome.targets.some((t) => t.outcome === 'replaced')) {
    console.log('Your previous statusLine was saved; `wmux setup-statusline --remove` restores it.');
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

/** Parsed CLI intent. Split out from the dispatcher so the flag rules can be
 *  tested — the dispatcher itself reaches for the real `~/.claude`, which is
 *  not something a test may touch. */
export type StatuslineArgs =
  | { action: 'help' }
  | { action: 'error'; message: string }
  | { action: 'status' }
  | { action: 'remove' }
  | { action: 'install'; force: boolean };

export function parseStatuslineArgs(args: string[]): StatuslineArgs {
  if (args.includes('--help') || args.includes('-h')) return { action: 'help' };
  const remove = args.includes('--remove');
  const status = args.includes('--status');
  const force = args.includes('--force');
  if (remove && status) {
    return { action: 'error', message: '--remove and --status are mutually exclusive.' };
  }
  if (force && (remove || status)) {
    return { action: 'error', message: '--force only applies to an install.' };
  }
  const unknown = args.filter((a) => a !== '--remove' && a !== '--status' && a !== '--force');
  if (unknown.length > 0) {
    return {
      action: 'error',
      message: `Unknown argument(s): ${unknown.join(', ')}. Run 'wmux setup-statusline --help' for usage.`,
    };
  }
  if (status) return { action: 'status' };
  if (remove) return { action: 'remove' };
  return { action: 'install', force };
}

export async function handleSetupStatusline(args: string[], jsonMode: boolean): Promise<void> {
  const parsed = parseStatuslineArgs(args);
  if (parsed.action === 'help') {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
    return;
  }
  if (parsed.action === 'error') {
    console.error(parsed.message);
    process.exit(1);
    return;
  }

  const paths = defaultPaths();
  if (parsed.action === 'status') {
    printStatus(statusStatusline(paths), jsonMode);
    return;
  }
  const outcome =
    parsed.action === 'remove' ? removeStatusline(paths) : installStatusline(paths, { force: parsed.force });
  printOutcome(outcome, jsonMode, 'installed');
  if (!outcome.ok) process.exit(1);
}
