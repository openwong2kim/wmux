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
  // NOTE (#980): this stays the WAIT list and deliberately keeps our own
  // helpers and the daemon in it. Everything here has to be gone before
  // Setup.exe may run; which of them we kill ourselves is a separate question,
  // answered by `selectOwnTreePids`.
  // Backslash explicitly, not `path.sep`. Every input here is a Windows path
  // read out of Win32_Process, and this only ever runs on win32 — but the
  // function is pure, so it is unit-tested on the Linux and macOS CI legs too,
  // where `path.sep` is `/` and the prefix would match nothing. The separator
  // belongs to the DATA, not to the host.
  const trimmed = installRoot.replace(/[\\/]+$/, '');
  const prefix = `${trimmed}\\`.toLowerCase();
  return rows
    .filter((r) => r.pid !== ownPid && r.pid > 0)
    .filter((r) => r.executablePath.toLowerCase().startsWith(prefix))
    .map((r) => r.pid);
}

/**
 * One row of the install-root process enumeration.
 *
 * `parentPid` is carried because #980 turned on a distinction the original
 * query could not make: every Electron helper is the SAME `wmux.exe` under the
 * SAME root as the process doing the update, so an executable-path match cannot
 * tell our own renderer from a stranger's MCP server. Parentage can.
 */
export interface InstallRootProcess {
  pid: number;
  /** 0 when the enumeration did not report one — treated as "not ours". */
  parentPid: number;
  executablePath: string;
}

/** Parse `Get-CimInstance ... | ConvertTo-Json` rows. Tolerates the single-object form. */
export function parseProcessRows(stdout: string): InstallRootProcess[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: InstallRootProcess[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const pid = typeof o.ProcessId === 'number' ? o.ProcessId : NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // A missing or malformed parent reads as 0, which belongs to no tree — so
    // an unreadable parentage can only ever make a process look FOREIGN, never
    // make a stranger's process look like one of ours.
    const rawParent = o.ParentProcessId;
    const parentPid =
      typeof rawParent === 'number' && Number.isInteger(rawParent) && rawParent > 0
        ? rawParent
        : 0;
    out.push({
      pid,
      parentPid,
      executablePath: typeof o.ExecutablePath === 'string' ? o.ExecutablePath : '',
    });
  }
  return out;
}

/**
 * #980 — the pids that belong to OUR OWN process tree, transitively.
 *
 * The force-kill on the install path was documented as "the processes nothing
 * else takes down" — the MCP servers, which run out of the install root but are
 * owned by agent hosts rather than by us. It was IMPLEMENTED as "every process
 * under the root except the daemon", and on Windows every Electron helper is
 * the same `wmux.exe` under the same root, so it swept up our own renderer, GPU
 * and utility children as well.
 *
 * That is not a cosmetic over-reach. The next thing the install path does is
 * `app.quit()`, whose `before-quit` handler awaits a session save IN THE
 * RENDERER — the renderer that was just force-killed. The await never settles,
 * the quit never completes, and the main process stays alive holding the very
 * install root the waiter is waiting to see released. Measured on the reporter's
 * machine: the main process survived a full day across two install attempts.
 *
 * Our own children need no killing. `app.quit()` takes them down, and they stay
 * in the waiter's WAIT list either way — so the installer still cannot start
 * before they are gone. Sparing them costs nothing and buys back the quit.
 */
export function selectOwnTreePids(
  rows: ReadonlyArray<{ pid: number; parentPid: number }>,
  ownPid: number,
): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    if (r.parentPid <= 0) continue;
    const siblings = childrenOf.get(r.parentPid);
    if (siblings) siblings.push(r.pid);
    else childrenOf.set(r.parentPid, [r.pid]);
  }
  // Breadth-first from ourselves. `seen` doubles as the cycle guard: Windows
  // recycles pids, so a stale parent reference can close a loop and an
  // unguarded walk would never terminate.
  const own = new Set<number>();
  const queue = [ownPid];
  const seen = new Set<number>([ownPid]);
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      own.add(child);
      queue.push(child);
    }
  }
  return own;
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
  // Same check the pids get. A zero, negative or NaN budget would put the
  // deadline in the past, so the lock loop would fall through on its first
  // pass — turning the gate that makes this whole change work into a no-op.
  if (!Number.isInteger(plan.lockBudgetMs) || plan.lockBudgetMs <= 0) return null;

  const pidList = plan.pids.join(',');
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${psQuote(plan.installRoot)}`,
    `$setup = ${psQuote(plan.setupExePath)}`,
    `$marker = ${psQuote(plan.abortMarkerPath)}`,
    `$budget = ${plan.lockBudgetMs}`,
    // Single-instance gate, FIRST — before a handle is captured or anything
    // else happens. The quit watchdog unlatches `isInstalling` after 30 s so a
    // refused quit stays retryable, but the waiter it spawned can still be
    // inside its own budget (up to two lock windows) — so a retry would spawn
    // a SECOND waiter watching the same root, and two of them can reach
    // Start-Process on the same Setup.exe. Two concurrent Squirrel installs
    // against one root is precisely the corruption #866 exists to prevent, so
    // the guard lives HERE, where the collision happens, not in timing
    // arithmetic between the watchdog and the budgets (coderabbit, #980).
    //
    // A named mutex gives exactly the wanted semantics for free: it exists
    // only while some process holds a handle to it, so a LIVE earlier waiter
    // blocks the newcomer (exit 5 — the incumbent owns the install; the
    // newcomer writes the marker for whichever boot reads it next, #1043),
    // while a dead or finished one leaves nothing behind and the newcomer
    // proceeds. No state file to go stale, nothing to clean up. The name
    // embeds the install root so two different installations (per user,
    // portable copies) can never block each other.
    `$mtxName = 'wmux-install-waiter-' + ($root -replace '[^A-Za-z0-9]', '_')`,
    `$mtxCreated = $false`,
    `$mtx = New-Object System.Threading.Mutex -ArgumentList $true, $mtxName, ([ref]$mtxCreated)`,
    // #1043 — this used to be a bare `exit 5`: correct (it stops a second
    // Squirrel install from racing the first), but silent. A repeat click
    // while an earlier waiter is still alive produced literally nothing —
    // no marker, so nothing for the app to report on the boot that follows —
    // which reads exactly like "the button did nothing" even though the
    // mutex did its job. Writing the marker here reuses the SAME pull-based
    // notice AppLayout's useRefusedInstallNotice already shows at every boot
    // (#866) instead of inventing a second reporting path for one branch.
    `if (-not $mtxCreated) {`,
    `  Set-Content -LiteralPath $marker -Value 'install-aborted: another install is already in progress' -Encoding utf8`,
    `  exit 5`,
    `}`,
    // #1043 — best-effort "please wait" indicator for the whole silent
    // window below. Deliberately outside every correctness path: every use
    // of $form is null-checked and wrapped in its own try/catch, so a
    // machine where Add-Type/WinForms misbehaves (a locked-down policy, a
    // server SKU with no display subsystem) degrades to exactly today's
    // silent-but-correct wait, never to a failed install. It lives here and
    // not in the Electron app for the same reason the waiter itself does
    // (see spawnInstallWaiter): the app's own process tree is precisely what
    // has to fully let go of the install root, so anything meant to render
    // for the whole wait has to run outside that tree.
    `$form = $null`,
    `try {`,
    `  Add-Type -AssemblyName System.Windows.Forms`,
    `  Add-Type -AssemblyName System.Drawing`,
    `  $form = New-Object System.Windows.Forms.Form`,
    `  $form.Text = 'wmux update'`,
    `  $form.FormBorderStyle = 'FixedToolWindow'`,
    `  $form.StartPosition = 'CenterScreen'`,
    `  $form.TopMost = $true`,
    `  $form.ShowInTaskbar = $false`,
    `  $form.ClientSize = New-Object System.Drawing.Size(360, 90)`,
    `  $label = New-Object System.Windows.Forms.Label`,
    `  $label.Text = "Installing the wmux update...\`nThis window closes on its own."`,
    `  $label.Dock = 'Fill'`,
    `  $label.TextAlign = 'MiddleCenter'`,
    `  $form.Controls.Add($label)`,
    `  $form.Show()`,
    `  [System.Windows.Forms.Application]::DoEvents()`,
    `} catch { $form = $null }`,
    // Capture HANDLES first. GetProcessById opens a handle now, so a later pid
    // recycle cannot make an exited process look alive (or a stranger's
    // process look like ours).
    `$handles = @()`,
    `foreach ($id in @(${pidList})) { try { $handles += [System.Diagnostics.Process]::GetProcessById($id) } catch { } }`,
    // Bounded, and the bound is the point. taskkill is best-effort: a process
    // it could not terminate would make an unbounded WaitForExit block forever,
    // and by then wmux has already quit — so the update would silently stall
    // with no marker and nothing to tell the user on the next boot. The whole
    // wait shares one deadline rather than giving each handle a fresh budget.
    // A Stopwatch, not [Environment]::TickCount. TickCount is a signed 32-bit
    // millisecond counter that WRAPS every ~24.9 days of uptime and then runs
    // negative: past the wrap, `TickCount + $budget` widens to Int64 while
    // TickCount itself is still negative, so `$left` comes out larger than
    // Int32.MaxValue, WaitForExit throws ArgumentOutOfRange, the `catch {}`
    // below swallows it, and every handle is skipped without ever setting
    // $stuck. The wait silently becomes a no-op on exactly the long-uptime
    // machines that most need it. A Stopwatch is monotonic and 64-bit (#980).
    //
    // #1043 — sliced into a poll instead of one long WaitForExit so the form
    // above can stay responsive (DoEvents needs to run periodically on THIS
    // thread; a single multi-second blocking wait would freeze it for the
    // whole slice). Same deadline, same "did every handle exit in budget"
    // contract as before — only the granularity changed. A WaitForExit
    // exception still reads as "this handle is not the blocker" ($exited
    // stays true), matching the original catch-and-continue.
    `$clock = [System.Diagnostics.Stopwatch]::StartNew()`,
    `$stuck = $false`,
    `foreach ($h in $handles) {`,
    `  while ($true) {`,
    `    $left = $budget - $clock.ElapsedMilliseconds`,
    `    if ($left -le 0) { $stuck = $true; break }`,
    `    $slice = [Math]::Min(200, $left)`,
    `    $exited = $true`,
    `    try { $exited = $h.WaitForExit([int]$slice) } catch { }`,
    `    if ($exited) { break }`,
    `    if ($form) { try { [System.Windows.Forms.Application]::DoEvents() } catch { } }`,
    `  }`,
    `  if ($stuck) { break }`,
    `}`,
    `if ($stuck) {`,
    `  if ($form) { try { $form.Close() } catch { } }`,
    `  Set-Content -LiteralPath $marker -Value 'install-aborted: a process under the install root would not exit' -Encoding utf8`,
    `  exit 3`,
    `}`,
    // Everything we knew about is gone. That is necessary, not sufficient: the
    // MCP hosts can have spawned a replacement into the root meanwhile.
    // Probe the loadable images, not just the .exe files. The delete that
    // failed in the field died on `ffmpeg.dll`, and measuring a live install
    // shows why: with the app running, 1 .exe is locked but 9 binaries are.
    // Probing every file instead would be the complete answer and costs 10.8 s
    // per pass against 0.7 s here — far too slow for a loop that re-checks
    // twice a second. Binaries are a sound proxy: a process holds its own image
    // and every module it loaded, so "no binary is locked" means the processes
    // are gone, and their handles on data files went with them.
    `$binExt = @('.exe', '.dll', '.node', '.asar')`,
    `function Test-RootLocked {`,
    `  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $binExt -contains $_.Extension })`,
    `  foreach ($f in $files) {`,
    `    try { $s = [System.IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None'); $s.Close() } catch { return $true }`,
    `  }`,
    `  return $false`,
    `}`,
    // Same clock, same reason. This loop is the gate that decides whether the
    // installer runs at all, so a wrapped counter here does not merely mistime
    // it — it collapses the whole budget into a single pass.
    `$lockClock = [System.Diagnostics.Stopwatch]::StartNew()`,
    `while ((Test-RootLocked) -and ($lockClock.ElapsedMilliseconds -lt $budget)) {`,
    `  if ($form) { try { [System.Windows.Forms.Application]::DoEvents() } catch { } }`,
    `  Start-Sleep -Milliseconds 500`,
    `}`,
    `if (Test-RootLocked) {`,
    // Refusing leaves a working old version. Launching anyway is precisely the
    // failure this module exists to prevent, so there is no "best effort" here.
    `  if ($form) { try { $form.Close() } catch { } }`,
    `  Set-Content -LiteralPath $marker -Value 'install-aborted: install root still locked' -Encoding utf8`,
    `  exit 2`,
    `}`,
    // The wait is over — Squirrel's own UI takes it from here once
    // Start-Process below succeeds, so ours has nothing left to say.
    `if ($form) { try { $form.Close() } catch { } }`,
    // A verified installer can still be gone by now — quarantined by AV,
    // swept by a temp cleaner. Under SilentlyContinue that failure is invisible
    // and the script would exit 0, leaving a user who just watched wmux quit
    // with no update and no explanation on the next boot.
    `$started = $true`,
    `try { Start-Process -FilePath $setup -ErrorAction Stop } catch { $started = $false }`,
    `if (-not $started) {`,
    `  Set-Content -LiteralPath $marker -Value 'install-aborted: the installer could not be started' -Encoding utf8`,
    `  exit 4`,
    `}`,
    `exit 0`,
  ].join('\n');
}

/**
 * What the install path needs to know about the tree it is about to take down.
 *
 * `pids` is the WAIT list — everything under the install root except ourselves.
 * `ownTree` is the subset of those that are our own descendants, which the
 * caller must NOT force-kill (see `selectOwnTreePids`). Both come from ONE
 * enumeration on purpose: two queries would be two different moments, and a
 * process that appeared between them would land in the kill list without ever
 * having been classified.
 */
export interface InstallRootSurvey {
  /** Everything under the root except us — what the waiter waits for. */
  pids: number[];
  /** Of those, our own descendants. They exit with `app.quit()`. */
  ownTree: Set<number>;
}

/** Enumerate, best-effort. win32-only; never throws into the update path. */
export function collectInstallRootProcesses(installRoot: string): InstallRootSurvey {
  const empty: InstallRootSurvey = { pids: [], ownTree: new Set() };
  if (process.platform !== 'win32') return empty;
  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const exeName = path.basename(process.execPath);
    if (!/^[\w][\w .-]*\.exe$/i.test(exeName)) return empty;
    const stdout = execFileSync(
      powershell,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true },
    );
    const rows = parseProcessRows(stdout);
    const pids = selectInstallRootPids(rows, installRoot, process.pid);
    // Intersect: a descendant of ours that does NOT run out of the install root
    // is not on the wait list either, so it has no business in this survey.
    const under = new Set(pids);
    const ownTree = new Set(
      [...selectOwnTreePids(rows, process.pid)].filter((p) => under.has(p)),
    );
    return { pids, ownTree };
  } catch {
    return empty;
  }
}

/** Wait-list only. Kept for callers (and the runtime suite) that never needed
 *  the ownership split. */
export function collectInstallRootPids(installRoot: string): number[] {
  return collectInstallRootProcesses(installRoot).pids;
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
    // The BOM is load-bearing. Windows PowerShell 5.1 decodes a BOM-less file
    // as the system ANSI code page, so on a Korean install every path we
    // embedded — all of them under the user profile — comes back mangled.
    // Measured: with `C:\Users\홍길동\...` the BOM-less script still exits 0
    // while writing to the wrong path, which is the worst shape a failure can
    // take here (silent success). With the BOM it behaves.
    fs.writeFileSync(scriptPath, '\uFEFF' + script, 'utf-8');
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

/**
 * Read the abort marker without clearing it. Pair with `clearAbortMarker`
 * AFTER the notice has actually been delivered — clearing on read loses the
 * only record of the refusal if the app dies before the renderer sees it, and
 * then it is never reportable again.
 */
export function readAbortMarker(markerPath: string): string | null {
  try {
    if (!fs.existsSync(markerPath)) return null;
    return fs.readFileSync(markerPath, 'utf-8').trim() || 'install-aborted';
  } catch {
    // A read failure is not a refusal — say nothing rather than invent one.
    return null;
  }
}

/**
 * Drop the marker so the notice fires once. Separate from the read so an
 * unlink failure (permissions, AV holding the file) cannot swallow a reason we
 * already have in hand; the marker simply survives to the next boot.
 */
export function clearAbortMarker(markerPath: string): void {
  try {
    fs.unlinkSync(markerPath);
  } catch {
    /* best-effort — a surviving marker re-reports, which beats losing it */
  }
}
