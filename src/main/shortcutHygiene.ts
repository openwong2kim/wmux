/**
 * Squirrel.Windows install-time shortcut hygiene (#863).
 *
 * Windows resolves a taskbar button's icon through the shortcut that carries
 * the window's AppUserModelID (`com.squirrel.wmux.wmux`, set in index.ts) —
 * NOT through the window or exe icon. One dead shortcut carrying that AUMID is
 * therefore enough to blank the running app's taskbar icon even when the exe,
 * the window icon, and every other shortcut are healthy. Verified A/B/A on a
 * live install: removing the dead link fixed the icon, restoring it broke the
 * icon again (issue #863).
 *
 * Two ways such dead links arise, both observed:
 *
 *  1. TOP-LEVEL link — installs from <=3.3.x wrote the Start Menu link at
 *     `Programs\wmux.lnk` and left it pointing at an `app-X.Y.Z` directory
 *     that a later update deleted. Measured: one such link survived three
 *     installs untouched (its target, app-3.3.0, was deleted over a year of
 *     updates ago). That path is now the app's one Start Menu entry again:
 *     Electron's toast setup owns it and rewrites it at every startup to match
 *     the running app (notification/startMenuEntry.ts, #2971), so this pass
 *     leaves it alone rather than become a second writer.
 *
 *  2. VERSIONED pins — pinning a running window records the live exe path
 *     (`<root>\app-X.Y.Z\wmux.exe`) into the pin's .lnk. The next update
 *     deletes that directory and the pin dies. Squirrel's own
 *     fixPinnedExecutables did not repair these in practice (same measurement
 *     as above).
 *
 * The repair is one PowerShell pass (the squirrelTeardown.ts pattern — hook
 * processes already shell out to powershell.exe, and WScript.Shell edits are
 * the one .lnk API available without native modules; measured to preserve the
 * link's PropertyStore, including the AUMID, across Save()):
 *
 *   - candidates: every *.lnk in the taskbar/Start "User Pinned" folders.
 *     Desktop links are NOT touched here — `Update.exe --createShortcut`
 *     owns those — and neither is the top-level Start Menu entry (above).
 *   - only links whose target lies under OUR install root are considered;
 *     anything else is someone else's shortcut and is left alone.
 *   - a link whose target is not the root stub (`<root>\wmux.exe`) is
 *     retargeted to the stub, with the working dir set to the root and the
 *     icon pinned to `<root>\app.ico` (version-independent on both axes).
 *     Retargeting, never deletion: pinned items cannot be re-created
 *     programmatically (Windows blocks pin automation), so a deleted pin is
 *     unrecoverable while a repaired one keeps working.
 *
 * Two more passes keep the Start Menu to one "wmux" entry (#2971):
 *   - `removeSecondStartMenuEntry`, at app startup: Squirrel's Start Menu link
 *     from installs before #2971 (`Programs\<publisher>\wmux.lnk`) is
 *     removed once the top-level entry exists and points into this install.
 *   - `removeToastEntries`, at uninstall: the top-level entry and the toast
 *     activator classes Electron registered, which Update.exe never removes.
 *
 * `stageRootIcon` covers the second half of #863: Squirrel materializes
 * `<root>\app.ico` by DOWNLOADING the nuspec iconUrl (raw.githubusercontent.com)
 * at install time, which fails on networks where that host is unreachable
 * (observed from the issue reporter's region) — leaving shortcuts with no icon
 * source at all. The same .ico already ships inside the package
 * (`resources\icon.ico`, byte-identical), so the hook copies it into place and
 * passes it to `--createShortcut --icon`, removing the network dependency.
 *
 * Everything here is best-effort and must never block the install: all entry
 * points swallow failures and return what they managed to do (the
 * squirrelTeardown contract).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

export interface ShortcutRepairAction {
  path: string;
  action: 'retargeted' | 'removed';
}

/** Exit code the script uses for "the COM object could not be created" (#962). */
const COM_UNAVAILABLE_EXIT = 3;
/** Exit code for "there were candidate links and not one could be opened". */
const NO_LINKS_READABLE_EXIT = 4;
/**
 * Printed by the script before it exits with COM_UNAVAILABLE_EXIT.
 *
 * Exit 3 is not ours alone — a CRT abort ends with 3 too — and the retry below
 * must not re-run the whole pass on one. The marker is what makes the code
 * mean what it says. It goes to STDOUT on purpose: under WDAC/AppLocker
 * ConstrainedLanguage, the environment most likely to refuse the COM object in
 * the first place, `[Console]::Error.WriteLine` is itself a blocked method call.
 */
const COM_UNAVAILABLE_MARKER = 'WMUX_COM_UNAVAILABLE';
/** Same idea for "candidates existed, none opened". */
const NO_LINKS_READABLE_MARKER = 'WMUX_NO_LINKS_READABLE';
/**
 * Total wall-clock budget for the pass, retry included. This runs synchronously
 * inside the Squirrel install hook, which Squirrel cancels at ~15 s — so the
 * retry has to share the old single-attempt budget, not double it.
 */
const REPAIR_BUDGET_MS = 15_000;

/**
 * Outcome of one repair pass.
 *
 * `failure` separates the two states an empty `actions` used to conflate:
 * nothing needed repair (failure `null`) and the pass could not run at all.
 * Callers still cannot be made to care — repairInstalledShortcuts drops it —
 * but the log line and the runtime test can now say which one happened.
 */
export interface RepairPassResult {
  actions: ShortcutRepairAction[];
  failure: string | null;
}

/** Locations the repair pass reads. Overridable so tests use temp dirs. */
export interface RepairLocations {
  /** Directories whose *.lnk children are examined (pin folders). */
  pinDirs: string[];
}

/**
 * Paths are embedded in a single-quoted PowerShell literal, where `$`, a
 * backtick and `"` are all literal and an apostrophe is escaped by doubling
 * (measured). So the only characters that can break out are the line
 * terminators, which would split the statement-per-line script this module
 * assembles.
 *
 * Rejecting more than that is not "extra safety" — it silently disables the
 * repair for legitimate Windows profiles (`C:\Users\O'Connor\...`, a folder
 * named `$app`), which is the failure mode this whole module exists to remove.
 */
export function isSafePsPathLiteral(p: string): boolean {
  return p.length > 0 && !/[\r\n]/.test(p);
}

/** Single-quoted PS literal; an embedded apostrophe is doubled. */
function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/** `%APPDATA%\Microsoft\Windows\Start Menu\Programs`. */
export function programsDirIn(appData: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

export function defaultRepairLocations(appData: string): RepairLocations {
  const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
  return { pinDirs: [path.join(pinned, 'TaskBar'), path.join(pinned, 'StartMenu')] };
}

/**
 * Build the repair script. Pure — exported for unit tests.
 *
 * The script's contract: examine each candidate .lnk; skip links whose target
 * is missing/empty or not under `<root>\`; retarget the rest to the stub
 * unless the target already IS the stub. Never deletes. Emits a compact JSON
 * array of {path, action} — empty output means nothing needed repair.
 */
export function buildRepairScript(rootDir: string, loc: RepairLocations): string | null {
  const paths = [rootDir, ...loc.pinDirs];
  if (!paths.every(isSafePsPathLiteral)) return null;

  const pinArray = loc.pinDirs.map(psQuote).join(', ');

  // ASCII-only, single statement per line: this travels through execFileSync
  // argv into powershell -Command.
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${psQuote(rootDir)}`,
    `$stub = Join-Path $root 'wmux.exe'`,
    `if (-not (Test-Path $stub)) { Write-Output '[]'; exit 0 }`,
    // Only pin the icon when the file is actually there. Writing an
    // IconLocation that resolves to nothing reproduces the very bug this pass
    // exists to fix; with no icon staged, leaving IconLocation empty makes the
    // shell fall back to the (version-stable) stub's embedded icon.
    `$icon = Join-Path $root 'app.ico'`,
    `$haveIcon = Test-Path -LiteralPath $icon`,
    `$cands = @()`,
    `foreach ($d in @(${pinArray})) { if (Test-Path $d) { $cands += @(Get-ChildItem -LiteralPath $d -Filter *.lnk | ForEach-Object { $_.FullName }) } }`,
    `$sh = New-Object -ComObject WScript.Shell`,
    // A refused COM class factory (a loaded machine, an antivirus holding the
    // registration) leaves $sh null, and with SilentlyContinue every read
    // through it then fails quietly: the pass emits `[]` and reads exactly like
    // "nothing needed repair". Fail loudly instead — a broken icon that never
    // got fixed and a pass that never ran must not look the same (#962).
    // Placed before ANY .lnk is touched, which is what makes the caller's retry
    // safe: nothing has been written when this branch is taken.
    `if (-not $sh) { Write-Output '${COM_UNAVAILABLE_MARKER}'; exit ${COM_UNAVAILABLE_EXIT} }`,
    `$out = @()`,
    `$opened = 0`,
    `$unopened = 0`,
    `foreach ($p in $cands) {`,
    `  if (-not (Test-Path -LiteralPath $p)) { continue }`,
    `  $l = $sh.CreateShortcut($p)`,
    // CreateShortcut can fail per-link too (a locked or corrupt .lnk, WSH
    // policy, a COM server that died mid-loop) and SilentlyContinue turns that
    // into a skipped candidate — the same invisible `[]` one level down. Count
    // them so "nothing needed repair" cannot be reported by a pass that could
    // not read a single shortcut.
    `  if (-not $l) { $unopened++; continue }`,
    `  $opened++`,
    `  $t = $l.TargetPath`,
    `  if (-not $t) { continue }`,
    `  if (-not $t.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }`,
    `  if ($t -ieq $stub) { continue }`,
    `  $l.TargetPath = $stub`,
    `  $l.WorkingDirectory = $root`,
    `  if ($haveIcon) { $l.IconLocation = "$icon,0" }`,
    // Save() on a read-only/locked .lnk fails WITHOUT setting $false on $? —
    // measured — so only try/catch tells us whether the edit reached disk.
    // Reporting a retarget that never happened would send the caller (and the
    // next debugger of a blank icon) down the wrong path.
    `  $saved = $true`,
    `  try { $l.Save() } catch { $saved = $false }`,
    `  if (-not $saved) { continue }`,
    `  $out += @{ path = $p; action = 'retargeted' }`,
    `}`,
    `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh) | Out-Null`,
    `if ($opened -eq 0 -and $unopened -gt 0) { Write-Output '${NO_LINKS_READABLE_MARKER}'; exit ${NO_LINKS_READABLE_EXIT} }`,
    `ConvertTo-Json @($out) -Compress`,
  ].join('\n');
}

/** Parse the script's JSON output. Tolerates empty/garbage (returns []). */
export function parseRepairOutput(stdout: string): ShortcutRepairAction[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: ShortcutRepairAction[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.path !== 'string') continue;
    if (o.action !== 'retargeted' && o.action !== 'removed') continue;
    out.push({ path: o.path, action: o.action });
  }
  return out;
}

/** `<root>` from the hook process's own exe (`<root>\app-X.Y.Z\wmux.exe`). */
function rootFromExecPath(execPath: string): string {
  return path.resolve(path.dirname(execPath), '..');
}

/**
 * Copy the packaged `resources\icon.ico` to `<root>\app.ico` so shortcut
 * icons never depend on Squirrel's iconUrl download. Returns the staged path,
 * or null when nothing could be staged (missing source — nothing to do).
 */
export function stageRootIcon(execPath: string): string | null {
  try {
    const src = path.join(path.dirname(execPath), 'resources', 'icon.ico');
    if (!fs.existsSync(src)) return null;
    const dest = path.join(rootFromExecPath(execPath), 'app.ico');
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}

/** One powershell run: the script's stdout, or why it did not produce any. */
type RunOutcome = { stdout: string } | { failure: string; retryable: boolean };

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Why a powershell run produced no usable output (sync and async runs alike). */
function classifyFailure(err: unknown): { failure: string; retryable: boolean } {
  const e = err as {
    status?: number | null; code?: string | number | null; signal?: string | null;
    stdout?: string | Buffer; stderr?: string | Buffer;
  };
  // Deliberately NOT e.message: execFile puts the whole command line in it,
  // and that command line is kilobytes of PowerShell carrying the user's
  // profile paths — which would then land in a log line and in a failing
  // test's message. status/signal/code answer the question e.message was
  // being used for, and they distinguish a timeout (signal) from a missing
  // interpreter (code) instead of blurring both into "failed". (execFile's
  // async error carries the exit status in `code`.)
  const status = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : null;
  const out = `${e.stdout ? String(e.stdout) : ''}${e.stderr ? String(e.stderr) : ''}`.trim();
  const comRefused = status === COM_UNAVAILABLE_EXIT && out.includes(COM_UNAVAILABLE_MARKER);
  const where = comRefused
    ? 'the WScript.Shell COM object was refused'
    : status === NO_LINKS_READABLE_EXIT && out.includes(NO_LINKS_READABLE_MARKER)
      ? 'no candidate shortcut could be opened'
      : `powershell exited status=${status ?? 'none'} signal=${e.signal ?? 'none'} code=${typeof e.code === 'string' ? e.code : 'none'}`;
  return {
    failure: out ? `${where} [${out.slice(0, 200)}]` : where,
    // Only a marked COM refusal is worth a second run. Exit 3 on its own is
    // not ours — a runtime abort mid-loop ends with 3 too, and re-running
    // the whole pass on one of those would repeat work already done.
    retryable: comRefused,
  };
}

function runScriptSync(script: string, timeoutMs: number): RunOutcome {
  try {
    const stdout = execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { stdout };
  } catch (err) {
    return classifyFailure(err);
  }
}

function runScriptAsync(script: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        resolve(err ? classifyFailure(Object.assign(err, { stdout, stderr })) : { stdout });
      },
    );
  });
}

/**
 * The script's last statement is always `ConvertTo-Json`, so output that is not
 * JSON means it died before reaching it — which is exactly the "reads like
 * nothing needed repair" state this change exists to remove.
 */
function readActions(stdout: string): { actions: ShortcutRepairAction[] } | { failure: string } {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return { failure: `the script produced no JSON [${trimmed.slice(0, 120) || 'empty output'}]` };
  }
  return { actions: parseRepairOutput(trimmed) };
}

function appDataOrThrow(): string {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('no locations (APPDATA unset)');
  return appData;
}

// Running one hygiene pass. win32-only, best-effort, never throws: a hygiene
// failure must never block an install, an uninstall or a startup. EVERY
// failure exit goes through passFailure, so an empty action list never hides a
// pass that did not run (#962).
//
// A pass retries once when its script reports the COM object refused
// (COM_UNAVAILABLE_MARKER): that failure is transient (a class-factory request
// lost to load or to an antivirus), and a second powershell start is its own
// backoff. Anything else is reported as-is; a retry would just double the cost
// of a real problem. One budget for the whole pass, retry included: the
// Squirrel hooks are cancelled at ~15 s. A script that never prints the marker
// is never retried.

const NO_RUN: RepairPassResult = { actions: [], failure: null };
const UNSAFE_PATH = 'a path could not be embedded in the script safely';

function passFailure(label: string, reason: string): RepairPassResult {
  console.warn(`[shortcutHygiene] ${label} did not run: ${reason}`);
  return { actions: [], failure: reason };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The budget for the one retry, or null when there is none to run. */
function retryBudget(label: string, run: RunOutcome, deadline: number): number | null {
  if (!('failure' in run) || !run.retryable) return null;
  const left = deadline - Date.now();
  if (left > 1_000) {
    console.warn(`[shortcutHygiene] COM refused the ${label} — retrying once`);
    return left;
  }
  console.warn(`[shortcutHygiene] COM refused the ${label} — no budget left to retry`);
  return null;
}

function settle(label: string, run: RunOutcome): RepairPassResult {
  if ('failure' in run) return passFailure(label, run.failure);
  const read = readActions(run.stdout);
  if ('failure' in read) return passFailure(label, read.failure);
  return { actions: read.actions, failure: null };
}

function runPassSync(label: string, build: () => string | null, budgetMs: number): RepairPassResult {
  if (process.platform !== 'win32') return NO_RUN;
  try {
    const script = build();
    if (!script) return passFailure(label, UNSAFE_PATH);
    const deadline = Date.now() + budgetMs;
    let run = runScriptSync(script, budgetMs);
    const left = retryBudget(label, run, deadline);
    if (left !== null) run = runScriptSync(script, left);
    return settle(label, run);
  } catch (err) {
    return passFailure(label, errorText(err));
  }
}

async function runPassAsync(label: string, build: () => string | null, budgetMs: number): Promise<RepairPassResult> {
  if (process.platform !== 'win32') return NO_RUN;
  try {
    const script = build();
    if (!script) return passFailure(label, UNSAFE_PATH);
    const deadline = Date.now() + budgetMs;
    let run = await runScriptAsync(script, budgetMs);
    const left = retryBudget(label, run, deadline);
    if (left !== null) run = await runScriptAsync(script, left);
    return settle(label, run);
  } catch (err) {
    return passFailure(label, errorText(err));
  }
}

/** Run the repair pass and report whether it actually ran. */
export function runShortcutRepairPass(
  execPath: string,
  locations?: RepairLocations,
): RepairPassResult {
  return runPassSync('shortcut repair pass', () => {
    const loc = locations ?? defaultRepairLocations(appDataOrThrow());
    return buildRepairScript(rootFromExecPath(execPath), loc);
  }, REPAIR_BUDGET_MS);
}

/**
 * Run the repair pass. win32-only, best-effort, never throws — a hygiene
 * failure must never block the install itself.
 */
export function repairInstalledShortcuts(
  execPath: string,
  locations?: RepairLocations,
): ShortcutRepairAction[] {
  return runShortcutRepairPass(execPath, locations).actions;
}

// ── #2971: one Start Menu entry ──────────────────────────────────────────────

/** The registry key Electron's toast setup writes its activator class under. */
export const TOAST_ACTIVATOR_CLSID_KEY = 'HKCU:\\Software\\Classes\\CLSID';
/** The default value Electron gives every toast activator class it registers. */
const TOAST_ACTIVATOR_NAME = 'Electron Notification Activator';

/**
 * PowerShell predicate: the path lies under `$root\`. Quotes are trimmed
 * because a LocalServer32 value is a quoted command line; a .lnk target never
 * carries them.
 */
const UNDER_ROOT_PS =
  `$under = { param($p) $p -and $p.Trim('"').StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase) }`;

/** The top-level Start Menu entry Electron's toast setup owns. */
export function topLevelStartMenuLnk(appData: string): string {
  return path.join(programsDirIn(appData), 'wmux.lnk');
}

/** Locations of the startup pass. Overridable so tests use temp dirs. */
export interface SecondEntryLocations {
  /** The top-level entry that must exist, and point into this install, first. */
  topLevelLnk: string;
  /** Squirrel's link from installs before #2971: `Programs\<publisher>\wmux.lnk`. */
  publisherLnk: string;
}

/**
 * Squirrel names its Start Menu folder after the exe's CompanyName, which the
 * packager takes from package.json's author. Only that exact folder is ours to
 * clean: a user's own `Programs\Startup\wmux.lnk` or `Programs\Tools\wmux.lnk`
 * must survive. Null when the name could not be a single folder name.
 */
export function defaultSecondEntryLocations(appData: string, publisher: string): SecondEntryLocations | null {
  const name = publisher.trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) return null;
  if (name.toLowerCase() === 'startup') return null;
  return { topLevelLnk: topLevelStartMenuLnk(appData), publisherLnk: path.join(programsDirIn(appData), name, 'wmux.lnk') };
}

/**
 * Build the startup pass's script. Pure — exported for unit tests.
 *
 * Removes Squirrel's publisher-folder link only while the top-level entry
 * exists and points at a file that exists under `<root>\` — the working
 * replacement is in place first, so the app is never left without a working
 * Start Menu entry (a link left by a removed `app-X.Y.Z\` does not count) — and
 * only when the publisher link itself points into `<root>\`. Its folder goes
 * too once empty.
 */
export function buildSecondEntryRemovalScript(rootDir: string, loc: SecondEntryLocations): string | null {
  const paths = [rootDir, loc.topLevelLnk, loc.publisherLnk];
  if (!paths.every(isSafePsPathLiteral)) return null;
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${psQuote(rootDir)}`,
    `$top = ${psQuote(loc.topLevelLnk)}`,
    `$pub = ${psQuote(loc.publisherLnk)}`,
    UNDER_ROOT_PS,
    `if (-not (Test-Path -LiteralPath $top) -or -not (Test-Path -LiteralPath $pub)) { Write-Output '[]'; exit 0 }`,
    `$sh = New-Object -ComObject WScript.Shell`,
    `if (-not $sh) { Write-Output '${COM_UNAVAILABLE_MARKER}'; exit ${COM_UNAVAILABLE_EXIT} }`,
    `$t = $sh.CreateShortcut($top)`,
    `$p = $sh.CreateShortcut($pub)`,
    `$keep = -not $t -or -not (& $under $t.TargetPath) -or -not (Test-Path -LiteralPath $t.TargetPath) -or -not $p -or -not (& $under $p.TargetPath)`,
    `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh) | Out-Null`,
    `if ($keep) { Write-Output '[]'; exit 0 }`,
    `$dir = Split-Path -Parent $pub`,
    `Remove-Item -LiteralPath $pub -Force`,
    `if (Test-Path -LiteralPath $pub) { Write-Output '[]'; exit 0 }`,
    `if (@(Get-ChildItem -LiteralPath $dir -Force).Count -eq 0) { Remove-Item -LiteralPath $dir -Force }`,
    `ConvertTo-Json @(@{ path = $pub; action = 'removed' }) -Compress`,
  ].join('\n');
}

/**
 * At app startup: remove the Start Menu link installs before #2971 had
 * Squirrel write, once the top-level entry Electron's toast setup writes is
 * there. Runs a powershell only when both links exist. Async, win32-only,
 * best-effort, never throws.
 */
export async function removeSecondStartMenuEntry(
  execPath: string,
  publisher: string,
  locations?: SecondEntryLocations,
): Promise<RepairPassResult> {
  const label = 'second Start Menu entry removal';
  if (process.platform !== 'win32') return NO_RUN;
  let loc: SecondEntryLocations | null;
  try {
    loc = locations ?? defaultSecondEntryLocations(appDataOrThrow(), publisher);
  } catch (err) {
    return passFailure(label, errorText(err));
  }
  // Nothing to remove, or no entry to keep in its place yet.
  if (!loc || !fs.existsSync(loc.publisherLnk) || !fs.existsSync(loc.topLevelLnk)) return NO_RUN;
  const found = loc;
  return runPassAsync(label, () => buildSecondEntryRemovalScript(rootFromExecPath(execPath), found), REPAIR_BUDGET_MS);
}

/** What the uninstall pass removes. Overridable so tests use temp locations. */
export interface ToastEntryLocations {
  /** The top-level Start Menu entry Electron's toast setup owns. */
  topLevelLnk: string;
  /** PowerShell path of the key holding the activator classes. */
  clsidKey: string;
}

export function defaultToastEntryLocations(appData: string): ToastEntryLocations {
  return { topLevelLnk: topLevelStartMenuLnk(appData), clsidKey: TOAST_ACTIVATOR_CLSID_KEY };
}

/**
 * Build the uninstall script. Pure — exported for unit tests.
 *
 * Electron's toast setup writes the top-level Start Menu entry and a COM class
 * (`HKCU\Software\Classes\CLSID\{x}`, LocalServer32 = the running exe) and
 * never removes either; Update.exe --removeShortcut only knows its own links.
 * Removes the entry when its target lies under `<root>\`, and every activator
 * class whose LocalServer32 does, including ones left by earlier entries
 * (each new entry got a fresh CLSID). Anything pointing elsewhere is another
 * app's and is left alone. The registry part needs no COM, so a refused
 * WScript.Shell only skips the link; the script prints no COM marker, so this
 * pass is never retried. Emits the same JSON as the repair script.
 */
export function buildToastEntryRemovalScript(rootDir: string, loc: ToastEntryLocations): string | null {
  const paths = [rootDir, loc.topLevelLnk, loc.clsidKey];
  if (!paths.every(isSafePsPathLiteral)) return null;
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${psQuote(rootDir)}`,
    UNDER_ROOT_PS,
    `$out = @()`,
    `$top = ${psQuote(loc.topLevelLnk)}`,
    `if (Test-Path -LiteralPath $top) {`,
    `  $sh = New-Object -ComObject WScript.Shell`,
    `  $l = if ($sh) { $sh.CreateShortcut($top) } else { $null }`,
    `  if ($l -and (& $under $l.TargetPath)) {`,
    `    Remove-Item -LiteralPath $top -Force`,
    `    if (-not (Test-Path -LiteralPath $top)) { $out += @{ path = $top; action = 'removed' } }`,
    `  }`,
    `  if ($sh) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh) | Out-Null }`,
    `}`,
    `foreach ($k in @(Get-ChildItem -LiteralPath ${psQuote(loc.clsidKey)})) {`,
    `  if ($k.GetValue('') -ne '${TOAST_ACTIVATOR_NAME}') { continue }`,
    `  $s = $k.OpenSubKey('LocalServer32')`,
    `  $srv = if ($s) { $s.GetValue('') } else { $null }`,
    `  if ($s) { $s.Close() }`,
    `  if (-not (& $under $srv)) { continue }`,
    `  Remove-Item -LiteralPath $k.PSPath -Recurse -Force`,
    `  if (-not (Test-Path -LiteralPath $k.PSPath)) { $out += @{ path = $k.Name; action = 'removed' } }`,
    `}`,
    `ConvertTo-Json @($out) -Compress`,
  ].join('\n');
}

/** The uninstall pass's budget: it runs while Update.exe --removeShortcut does. */
const TOAST_ENTRY_BUDGET_MS = 8_000;

/**
 * Remove the Start Menu entry and toast activator classes Electron's toast
 * setup left for this install (#2971). For the uninstall hook. win32-only,
 * best-effort, never throws.
 */
export function removeToastEntries(
  execPath: string,
  locations?: ToastEntryLocations,
): RepairPassResult {
  return runPassSync('toast entry removal', () => {
    const loc = locations ?? defaultToastEntryLocations(appDataOrThrow());
    return buildToastEntryRemovalScript(rootFromExecPath(execPath), loc);
  }, TOAST_ENTRY_BUDGET_MS);
}
