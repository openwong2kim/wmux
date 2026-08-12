/**
 * Windows install teardown (#866).
 *
 * Squirrel's `Setup.exe` is a first-install program, not an updater: its first
 * action is a recursive delete of the whole install root ("burning it to the
 * ground" in its own log). Today `performInstall` launches it and only THEN
 * calls `app.quit()`, so the delete starts while our processes still have the
 * install root open. The delete throws, the exception escapes
 * `Squirrel.Update.Program.Install`, and the install aborts with the root
 * already half-deleted: no Update.exe, no stub, no launcher to retry from.
 *
 * This is not a race that a faster quit could win. Measured on a live install:
 *
 *   - `app.quit()` takes the DETACH branch (index.ts before-quit), which keeps
 *     the daemon running BY DESIGN — that is the persistence promise.
 *   - the daemon's own process image is `<root>\app-X.Y.Z\wmux.exe`, and a
 *     running image cannot be unlinked on Windows.
 *   - killing only the GUI left `DAEMON + 3 MCP servers` alive and the exe
 *     still reporting "being used by another process".
 *
 * So the install has to start against a genuinely dead tree. This module owns
 * that: enumerate everything running out of the install root, take it down,
 * and hand off to a detached waiter that starts Setup.exe only after every
 * process is confirmed gone AND the root is confirmed unlocked.
 *
 *      performInstall
 *          │  freeSpaceShortfall()  ── short ──► refuse, nothing written
 *          │
 *          │  collectInstallRootPids()   (self excluded)
 *          │  daemon.shutdown → pid-kill backstop  (caller)
 *          ▼
 *      spawnInstallWaiter(pids, setupExe)
 *          │   detached PowerShell, living OUTSIDE the install root
 *          │   (Setup.exe deletes that root — a waiter inside it deletes itself)
 *          │
 *          ├─ WaitForExit on a HANDLE captured per pid, not a pid poll.
 *          │  A pid poll is wrong twice over: Windows recycles pids, and a
 *          │  recycled pid reads as "still alive" forever.
 *          │
 *          ├─ then probe the root for locks. Killing a snapshot of pids does
 *          │  NOT stop the MCP hosts (claude.exe and friends) from spawning a
 *          │  fresh server into the directory we are about to delete — that is
 *          │  a TOCTOU window the pid list cannot close.
 *          │
 *          ├─ still locked after the budget? ABORT — never launch Setup.exe
 *          │  against a live tree. Aborting leaves the user on a working old
 *          │  version; proceeding is what destroys the installation.
 *          │
 *          └─ clear? start Setup.exe.
 *
 * The abort path writes a marker file the app reads on next boot, so a refused
 * update is diagnosable instead of looking like "the update button did nothing".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';

/**
 * Marker the waiter writes when it refuses to launch, relative to userData.
 *
 * Lives here rather than in AutoUpdater because two different processes need
 * the same name: the updater hands the path to the waiter, and the next boot
 * reads it back. A refused install is otherwise indistinguishable from "the
 * update button did nothing", which is the state this whole change is trying
 * to stop shipping.
 */
export const INSTALL_ABORT_MARKER = 'update-install-aborted.txt';

/** Result of the pre-flight space check. `null` when there is enough room. */
export interface SpaceShortfall {
  volume: string;
  neededBytes: number;
  freeBytes: number;
}

/** What the waiter is asked to do, and where it reports back. */
export interface WaiterPlan {
  pids: number[];
  setupExePath: string;
  installRoot: string;
  /** Marker written when the waiter refuses to launch. Read on next boot. */
  abortMarkerPath: string;
  /** How long to keep re-checking the root for locks before giving up. */
  lockBudgetMs: number;
}

/**
 * Paths land inside single-quoted PowerShell literals, where `$`, a backtick
 * and `"` are all literal and an apostrophe escapes by doubling. Only the line
 * terminators can break the statement-per-line script this module builds.
 * (Same rule, same reasoning as shortcutHygiene — an over-strict guard there
 * silently disabled the repair for `C:\Users\O'Connor`.)
 */
export function isSafePsPathLiteral(p: string): boolean {
  return p.length > 0 && !/[\r\n]/.test(p);
}

function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Volume-aware free-space check. The staging download and the install root can
 * live on different volumes (a redirected AppData, a mapped drive), so a single
 * "is there room" number is meaningless — each volume is budgeted separately
 * and the FIRST shortfall is reported.
 *
 * `probe` is injected so tests do not depend on the host's actual disks.
 */
export function freeSpaceShortfall(
  budgets: Array<{ dir: string; neededBytes: number }>,
  probe: (dir: string) => { volume: string; freeBytes: number } | null,
): SpaceShortfall | null {
  const perVolume = new Map<string, { needed: number; free: number }>();
  for (const b of budgets) {
    const info = probe(b.dir);
    if (!info) continue; // unreadable volume — do not invent a refusal
    const acc = perVolume.get(info.volume) ?? { needed: 0, free: info.freeBytes };
    acc.needed += b.neededBytes;
    acc.free = info.freeBytes;
    perVolume.set(info.volume, acc);
  }
  for (const [volume, { needed, free }] of perVolume) {
    if (free < needed) return { volume, neededBytes: needed, freeBytes: free };
  }
  return null;
}

/** Real disk probe. Separated from the pure logic above so tests can stub it. */
export function probeVolume(dir: string): { volume: string; freeBytes: number } | null {
  try {
    const volume = path.parse(path.resolve(dir)).root;
    const stats = fs.statfsSync(dir);
    return { volume, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

/**
 * Every process running out of the install root, minus ourselves.
 *
 * NOT the same query as squirrelTeardown's: that one classifies by role and
 * deliberately SPARES the daemon (the persistence promise). Here the daemon is
 * the main offender — the point is that nothing at all may hold the tree open.
 * Matching on the executable path rather than the image name also catches the
 * MCP servers, which are our exe but are owned by agent processes.
 */
export function selectInstallRootPids(
  rows: ReadonlyArray<{ pid: number; executablePath: string }>,
  installRoot: string,
  ownPid: number,
): number[] {
  const prefix = installRoot.endsWith(path.sep) ? installRoot : installRoot + path.sep;
  return rows
    .filter((r) => r.pid !== ownPid && r.pid > 0)
    .filter((r) => r.executablePath.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((r) => r.pid);
}

/** Parse `Get-CimInstance ... | ConvertTo-Json` rows. Tolerates the single-object form. */
export function parseProcessRows(stdout: string): Array<{ pid: number; executablePath: string }> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: Array<{ pid: number; executablePath: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const pid = typeof o.ProcessId === 'number' ? o.ProcessId : NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      pid,
      executablePath: typeof o.ExecutablePath === 'string' ? o.ExecutablePath : '',
    });
  }
  return out;
}

/**
 * The waiter script. Pure so its ordering guarantees are unit-testable — the
 * one property that matters is that Setup.exe is never started before both the
 * handle waits and the lock probe have passed.
 */
export function buildWaiterScript(plan: WaiterPlan): string | null {
  const paths = [plan.setupExePath, plan.installRoot, plan.abortMarkerPath];
  if (!paths.every(isSafePsPathLiteral)) return null;
  if (!plan.pids.every((p) => Number.isInteger(p) && p > 0)) return null;

  const pidList = plan.pids.join(',');
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${psQuote(plan.installRoot)}`,
    `$setup = ${psQuote(plan.setupExePath)}`,
    `$marker = ${psQuote(plan.abortMarkerPath)}`,
    `$budget = ${plan.lockBudgetMs}`,
    // Capture HANDLES first. GetProcessById opens a handle now, so a later pid
    // recycle cannot make an exited process look alive (or a stranger's
    // process look like ours).
    `$handles = @()`,
    `foreach ($id in @(${pidList})) { try { $handles += [System.Diagnostics.Process]::GetProcessById($id) } catch { } }`,
    `foreach ($h in $handles) { try { $h.WaitForExit() } catch { } }`,
    // Everything we knew about is gone. That is necessary, not sufficient: the
    // MCP hosts can have spawned a replacement into the root meanwhile.
    `function Test-RootLocked {`,
    `  $files = @(Get-ChildItem -LiteralPath $root -Recurse -Filter *.exe -File -ErrorAction SilentlyContinue)`,
    `  foreach ($f in $files) {`,
    `    try { $s = [System.IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None'); $s.Close() } catch { return $true }`,
    `  }`,
    `  return $false`,
    `}`,
    `$deadline = [Environment]::TickCount + $budget`,
    `while ((Test-RootLocked) -and ([Environment]::TickCount -lt $deadline)) { Start-Sleep -Milliseconds 500 }`,
    `if (Test-RootLocked) {`,
    // Refusing leaves a working old version. Launching anyway is precisely the
    // failure this module exists to prevent, so there is no "best effort" here.
    `  Set-Content -LiteralPath $marker -Value 'install-aborted: install root still locked' -Encoding utf8`,
    `  exit 2`,
    `}`,
    `Start-Process -FilePath $setup`,
    `exit 0`,
  ].join('\n');
}

/** Enumerate, best-effort. win32-only; never throws into the update path. */
export function collectInstallRootPids(installRoot: string): number[] {
  if (process.platform !== 'win32') return [];
  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const exeName = path.basename(process.execPath);
    if (!/^[\w][\w .-]*\.exe$/i.test(exeName)) return [];
    const stdout = execFileSync(
      powershell,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" -ErrorAction SilentlyContinue | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true },
    );
    return selectInstallRootPids(parseProcessRows(stdout), installRoot, process.pid);
  } catch {
    return [];
  }
}

/**
 * Write the waiter to a temp directory and start it detached.
 *
 * The script deliberately does NOT live under the install root: Setup.exe
 * deletes that root, and a waiter inside it would be deleting itself while
 * running. Returns the script path on success, null when it could not start —
 * and a null MUST make the caller abandon the install rather than fall back to
 * launching Setup.exe directly.
 */
export function spawnInstallWaiter(plan: WaiterPlan): string | null {
  if (process.platform !== 'win32') return null;
  const script = buildWaiterScript(plan);
  if (!script) return null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-install-waiter-'));
    const scriptPath = path.join(dir, 'wait-and-install.ps1');
    fs.writeFileSync(scriptPath, script, 'utf-8');
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return scriptPath;
  } catch {
    return null;
  }
}

/**
 * The daemon's pid, or null when it cannot be read.
 *
 * Only used to EXCLUDE it from the force-kill list — the daemon is taken down
 * gracefully so it can flush scrollback first. A null here therefore fails in
 * the safe direction on the install path (the daemon gets force-killed like
 * anything else, losing a flush but not the install), which is why this does
 * not reach for the launcher's verify-before-kill machinery.
 */
export function readDaemonPid(wmuxDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim();
    // Strict digits rather than parseInt: parseInt('12.5') is 12, so a
    // malformed pid file would silently name a DIFFERENT process — and the one
    // thing this value does is decide which process to spare from a kill.
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Force-kill the given pids (tree-kill, so Chromium helpers go with their
 * parent). Returns the pids actually killed.
 *
 * Used for the processes nothing else takes down on the install path: the MCP
 * servers run out of the install root but are owned by agent hosts, not by us,
 * so a normal quit leaves them holding the tree open. The daemon is NOT in this
 * list — it gets the graceful `daemon.shutdown` path, which flushes scrollback
 * before exiting.
 *
 * Best-effort by construction: a survivor is caught by the waiter's lock probe,
 * which refuses the install rather than destroying it.
 */
export function terminatePids(pids: readonly number[]): number[] {
  if (process.platform !== 'win32') return [];
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  const killed: number[] = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
        timeout: 10_000,
        windowsHide: true,
        stdio: 'ignore',
      });
      killed.push(pid);
    } catch {
      /* already gone, or access denied — the lock probe is the real gate */
    }
  }
  return killed;
}

/** Read + clear the abort marker. Called at boot so a refusal is reportable. */
export function consumeAbortMarker(markerPath: string): string | null {
  try {
    if (!fs.existsSync(markerPath)) return null;
    const text = fs.readFileSync(markerPath, 'utf-8').trim();
    fs.unlinkSync(markerPath);
    return text || 'install-aborted';
  } catch {
    return null;
  }
}
