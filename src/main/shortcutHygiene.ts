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
 *  1. LEGACY layout — installs from <=3.3.x wrote the Start Menu link at
 *     `Programs\wmux.lnk` (top level). Squirrel now writes
 *     `Programs\<author>\wmux.lnk` and `--createShortcut` never revisits the
 *     old location, so the legacy link survives every update pointing at an
 *     `app-X.Y.Z` directory that no longer exists. Measured: one such link
 *     survived three installs untouched (its target, app-3.3.0, was deleted
 *     over a year of updates ago).
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
 *   - candidates: the legacy top-level Start Menu link + every *.lnk in the
 *     taskbar/Start "User Pinned" folders. Desktop and publisher-folder links
 *     are NOT touched here — `Update.exe --createShortcut` owns and rewrites
 *     those on every install/update.
 *   - only links whose target lies under OUR install root are considered;
 *     anything else is someone else's shortcut and is left alone.
 *   - a link whose target is not the root stub (`<root>\wmux.exe`) is
 *     retargeted to the stub, with the working dir set to the root and the
 *     icon pinned to `<root>\app.ico` (version-independent on both axes).
 *     Retargeting, not deletion, is the default: pinned items cannot be
 *     re-created programmatically (Windows blocks pin automation), so a
 *     deleted pin is unrecoverable while a repaired one keeps working.
 *   - the one deletion: the LEGACY top-level link, when dead AND the
 *     publisher-folder link exists — retargeting it would leave two identical
 *     Start Menu entries forever.
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
import { execFileSync } from 'child_process';

export interface ShortcutRepairAction {
  path: string;
  action: 'retargeted' | 'removed';
}

/** Exit code the script uses for "the COM object could not be created" (#962). */
const COM_UNAVAILABLE_EXIT = 3;

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
  /** Explicit .lnk paths to examine (the legacy top-level link). */
  legacyLnks: string[];
  /** Directories whose *.lnk children are examined (pin folders). */
  pinDirs: string[];
  /** Publisher-folder link whose existence allows deleting a dead legacy link. */
  publisherLnk: string;
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

export function defaultRepairLocations(appData: string): RepairLocations {
  const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
  return {
    legacyLnks: [path.join(programs, 'wmux.lnk')],
    pinDirs: [path.join(pinned, 'TaskBar'), path.join(pinned, 'StartMenu')],
    // Any one-level subfolder of Programs holding a wmux.lnk counts as the
    // publisher link — the author name is Squirrel metadata, not ours to
    // hardcode. Checked via wildcard inside the script.
    publisherLnk: path.join(programs, '*', 'wmux.lnk'),
  };
}

/**
 * Build the repair script. Pure — exported for unit tests.
 *
 * The script's contract: examine each candidate .lnk; skip links whose target
 * is missing/empty or not under `<root>\`; retarget the rest to the stub
 * unless the target already IS the stub; delete (not retarget) a legacy link
 * whose target is dead while a publisher link exists. Emits a compact JSON
 * array of {path, action} — empty output means nothing needed repair.
 */
export function buildRepairScript(rootDir: string, loc: RepairLocations): string | null {
  const paths = [rootDir, ...loc.legacyLnks, ...loc.pinDirs, loc.publisherLnk];
  if (!paths.every(isSafePsPathLiteral)) return null;

  const legacyArray = loc.legacyLnks.map(psQuote).join(', ');
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
    `$legacy = @(${legacyArray})`,
    `$cands = @() + $legacy`,
    `foreach ($d in @(${pinArray})) { if (Test-Path $d) { $cands += @(Get-ChildItem -LiteralPath $d -Filter *.lnk | ForEach-Object { $_.FullName }) } }`,
    `$pubExists = @(Get-Item ${psQuote(loc.publisherLnk)}).Count -gt 0`,
    `$sh = New-Object -ComObject WScript.Shell`,
    // A refused COM class factory (a loaded machine, an antivirus holding the
    // registration) leaves $sh null, and with SilentlyContinue every read
    // through it then fails quietly: the pass emits `[]` and reads exactly like
    // "nothing needed repair". Fail loudly instead — a broken icon that never
    // got fixed and a pass that never ran must not look the same (#962).
    `if (-not $sh) { [Console]::Error.WriteLine('WScript.Shell COM object unavailable'); exit ${COM_UNAVAILABLE_EXIT} }`,
    `$out = @()`,
    `foreach ($p in $cands) {`,
    `  if (-not (Test-Path -LiteralPath $p)) { continue }`,
    `  $l = $sh.CreateShortcut($p)`,
    `  $t = $l.TargetPath`,
    `  if (-not $t) { continue }`,
    `  if (-not $t.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }`,
    `  if ($t -ieq $stub) { continue }`,
    `  $dead = -not (Test-Path -LiteralPath $t)`,
    `  if ($dead -and $pubExists -and ($legacy -icontains $p)) { Remove-Item -LiteralPath $p -Force; $out += @{ path = $p; action = 'removed' }; continue }`,
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
function runRepairScript(script: string): { stdout: string } | { failure: string; comUnavailable: boolean } {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  try {
    const stdout = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true,
    });
    return { stdout };
  } catch (err) {
    const e = err as { status?: number; stderr?: string | Buffer; message?: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    const status = typeof e.status === 'number' ? e.status : null;
    return {
      failure: `powershell exited ${status ?? 'abnormally'}${stderr ? `: ${stderr}` : `: ${e.message ?? 'unknown error'}`}`,
      comUnavailable: status === COM_UNAVAILABLE_EXIT,
    };
  }
}

/**
 * Run the repair pass and report whether it actually ran. win32-only,
 * best-effort, never throws — a hygiene failure must never block the install.
 *
 * Retries once when the COM object was refused: that failure is transient (a
 * class-factory request lost to load or to an antivirus), and a second
 * powershell start is its own backoff. Anything else is reported as-is; a
 * retry would just double the cost of a real problem.
 */
export function runShortcutRepairPass(
  execPath: string,
  locations?: RepairLocations,
): RepairPassResult {
  if (process.platform !== 'win32') return { actions: [], failure: null };
  try {
    const appData = process.env.APPDATA;
    const loc = locations ?? (appData ? defaultRepairLocations(appData) : null);
    if (!loc) return { actions: [], failure: 'no repair locations (APPDATA unset)' };
    const script = buildRepairScript(rootFromExecPath(execPath), loc);
    if (!script) return { actions: [], failure: 'a path could not be embedded in the script safely' };

    for (let attempt = 0; attempt < 2; attempt++) {
      const run = runRepairScript(script);
      if ('stdout' in run) return { actions: parseRepairOutput(run.stdout), failure: null };
      if (run.comUnavailable && attempt === 0) {
        console.warn('[shortcutHygiene] COM refused the repair pass — retrying once');
        continue;
      }
      console.warn(`[shortcutHygiene] shortcut repair pass did not run: ${run.failure}`);
      return { actions: [], failure: run.failure };
    }
    return { actions: [], failure: 'the repair pass exhausted its retries' };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    console.warn(`[shortcutHygiene] shortcut repair pass did not run: ${failure}`);
    return { actions: [], failure };
  }
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
