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
import { spawn, execFileSync, type ChildProcess } from 'child_process';

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

/**
 * #1056 — heartbeat the waiter writes as its first act, relative to userData.
 * Not the abort marker: this says "the process ran at all," not "it refused."
 * Cleared before each attempt so a stale one from a prior run cannot pass the
 * check for a waiter that never started this time.
 */
export const INSTALL_READY_MARKER = 'update-install-ready.tmp';

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
  /**
   * #1056 — written as the waiter's very first act, before anything else
   * (even the mutex). The caller polls for it before committing to the
   * daemon shutdown and the force-kill: its absence after a short budget
   * means the process died before running a single line of the script, which
   * every other signal (the abort marker, a Squirrel log) requires reaching
   * further than that to produce. See spawnInstallWaiter / AutoUpdater for
   * why this can happen even though the process is spawned `detached`.
   */
  readyMarkerPath: string;
  /** How long to keep re-checking the root for locks before giving up. */
  lockBudgetMs: number;
  /**
   * #1084 — subset of `pids` (own-tree, never the daemon) that the waiter may
   * force-kill after `forceKillGraceMs` instead of counting them toward the
   * `lockBudgetMs` stuck-and-refuse verdict. These already got `app.quit()`
   * and have no flush to protect (unlike the daemon, which is deliberately
   * never in this list), so a hang here costs nothing to end forcibly.
   */
  forceKillEligiblePids: number[];
  /** How long an eligible pid gets before the waiter kills it. Short: see
   *  OWN_TREE_FORCE_KILL_GRACE_MS in AutoUpdater.ts for the reasoning. */
  forceKillGraceMs: number;
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
 * #1136 — the VBScript launcher for the hidden waiter transport.
 *
 * Root cause it exists for, measured on this box (Win11 26200, default
 * terminal = "Let Windows decide" → Windows Terminal): libuv turns
 * `windowsHide: true` into `CREATE_NO_WINDOW`, but `detached: true` also sets
 * `DETACHED_PROCESS` — and the two are mutually exclusive console-creation
 * flags, so `DETACHED_PROCESS` wins. The console child then allocates its own
 * console, that allocation goes through the Win11 default-terminal delegation,
 * and Windows Terminal opens a real, visible window. Proven by A/B: the SAME
 * `cmd.exe`, same `windowsHide: true`, produced a visible `WindowsTerminal`
 * window with `detached: true` and none without it. So this is specific to the
 * detached waiter transports; the module's non-detached `execFileSync` calls
 * (probeVolume, terminatePids) are unaffected and are left alone.
 *
 * `wscript.exe` is a GUI-subsystem host: it never allocates a console, so
 * nothing reaches the delegation layer. It then starts PowerShell through
 * `WshShell.Run(cmd, 0, True)`:
 *   - window style 0 = hidden, and because wscript already owns no console the
 *     child's console is created hidden rather than delegated,
 *   - `bWaitOnReturn = True` keeps wscript parked as the waiter's parent for
 *     its whole life. That is deliberate and NOT a cost regression: it is the
 *     same shape as the cmd.exe trampoline it replaces (one idle host process),
 *     and it is what keeps the refusal path's `taskkill /T` able to reach the
 *     PowerShell child. With `False` the launcher would exit immediately and
 *     orphan a waiter no tree-kill could find.
 *
 * VBScript string literals are double-quoted with `""` as the escape, so an
 * apostrophe in TEMP (the `O'Brien` case the cmd transport is pinned on) is
 * inert here. A literal `"` cannot occur in a Windows path, but rather than
 * rely on that this returns null for one — same fail-closed rule as
 * buildWaiterScript's stamp-path check.
 */
export function buildWaiterVbsLauncher(
  powershellPath: string,
  psArgs: readonly string[],
  scriptPath: string,
): string | null {
  // The two paths are QUOTED in the emitted command, so whitespace in them is
  // safe and only a quote or a line break could break out of the literal.
  if (![powershellPath, scriptPath].every((p) => p.length > 0 && !/["\r\n]/.test(p))) return null;
  // The switches are inserted BARE (quoting them would make CreateProcess look
  // for a file named `"-NoProfile"`), so they carry a stricter rule: any
  // whitespace would silently token-split one switch into two, which is the
  // kind of failure that produces a waiter running with the WRONG arguments
  // rather than no waiter at all. Fail closed instead — the caller falls
  // through to transport A.
  if (!psArgs.every((a) => a.length > 0 && !/[\s"]/.test(a))) return null;
  const q = (p: string) => `""${p}""`;
  const cmd = [q(powershellPath), ...psArgs, q(scriptPath)].join(' ');
  return [
    `Set sh = CreateObject("WScript.Shell")`,
    `sh.Run "${cmd}", 0, True`,
    '',
  ].join('\r\n');
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
export function buildWaiterScript(plan: WaiterPlan, launchStampPath?: string): string | null {
  const paths = [plan.setupExePath, plan.installRoot, plan.abortMarkerPath, plan.readyMarkerPath];
  if (!paths.every(isSafePsPathLiteral)) return null;
  if (!plan.pids.every((p) => Number.isInteger(p) && p > 0)) return null;
  // Same check the pids get. A zero, negative or NaN budget would put the
  // deadline in the past, so the lock loop would fall through on its first
  // pass — turning the gate that makes this whole change work into a no-op.
  if (!Number.isInteger(plan.lockBudgetMs) || plan.lockBudgetMs <= 0) return null;
  // #1084 — same shape as the pid/budget checks above: a malformed value here
  // must fail closed (build nothing) rather than silently force-kill nothing
  // or run with a nonsensical grace window.
  if (!plan.forceKillEligiblePids.every((p) => Number.isInteger(p) && p > 0)) return null;
  if (!Number.isInteger(plan.forceKillGraceMs) || plan.forceKillGraceMs <= 0) return null;
  // #1056 — optional execution-proof stamp. Stricter than isSafePsPathLiteral
  // on purpose: this path also rides through a cmd.exe trampoline command
  // line, where a double quote is structural. Optional, so the suites'
  // existing single-argument call sites stay legal — "no stamp" is a shape.
  if (launchStampPath !== undefined &&
    (!isSafePsPathLiteral(launchStampPath) || launchStampPath.includes('"'))) {
    return null;
  }
  const stampLines = launchStampPath === undefined ? [] : [
    // Immediately after the $ready heartbeat, still before the mutex: the
    // transport gate in spawnInstallWaiter polls for this file (a distinct
    // one per transport), and a newcomer that yields with exit 5 still
    // proves the transport works. Best-effort: a stamp that cannot be
    // written degrades to "transport unverified", never to a broken waiter.
    `$stampPath = ${psQuote(launchStampPath)}`,
    `try { Set-Content -LiteralPath $stampPath -Value 'launched' -Encoding utf8 } catch { }`,
  ];

  const pidList = plan.pids.join(',');
  const eligibleList = plan.forceKillEligiblePids.join(',');
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$root = ${psQuote(plan.installRoot)}`,
    `$setup = ${psQuote(plan.setupExePath)}`,
    `$marker = ${psQuote(plan.abortMarkerPath)}`,
    `$ready = ${psQuote(plan.readyMarkerPath)}`,
    `$budget = ${plan.lockBudgetMs}`,
    // #1056 — the very first thing this script does, before even the mutex.
    // A real machine showed the waiter's PowerShell engine starting and then
    // going silent forever, in the same second the app called app.quit(), with
    // none of the abort paths below ever reached (no marker, no Squirrel log).
    // Node's `detached: true` on Windows only requests DETACHED_PROCESS |
    // CREATE_NEW_PROCESS_GROUP — never CREATE_BREAKAWAY_FROM_JOB (confirmed in
    // libuv's win/process.c, which says so in its own comment) — so a parent
    // that is itself a member of an outer Job Object with KILL_ON_JOB_CLOSE can
    // still take a "detached" child down with it. This can't fix that
    // mechanism from here; it only proves whether the engine got far enough to
    // run a line of script at all, which is exactly the fact the caller is
    // missing when the whole update goes silent.
    `try { Set-Content -LiteralPath $ready -Value 'alive' -Encoding utf8 } catch { }`,
    ...stampLines,
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
    // blocks the newcomer (exit 5, silently — the incumbent owns the install
    // and the marker), while a dead or finished one leaves nothing behind and
    // the newcomer proceeds. No state file to go stale, nothing to clean up.
    // The name embeds the install root so two different installations (per
    // user, portable copies) can never block each other.
    //
    // #1043 considered having the newcomer write its own marker here, so a
    // repeat click that hits this branch is not silent on the next boot.
    // Reverted: the incumbent is the one still deciding the real outcome, up
    // to a further ~120s out. If it goes on to SUCCEED, it writes no marker at
    // all — and a marker the newcomer left behind here would sit there
    // unclaimed and get read on the next boot as "your update was refused,"
    // which is false. If the incumbent later fails, it overwrites whatever
    // this branch wrote anyway, so the newcomer's write only ever matters in
    // the narrow window where it is wrong. The #1043 fix for this branch's
    // silence lives in the "please wait" window below instead: that window is
    // owned by the INCUMBENT and stays on screen (topmost) for the whole wait,
    // so a user who reopens wmux and clicks "update" again sees it still
    // there rather than a second silent close.
    // #1043, coderabbit: the old name was 'wmux-install-waiter-' + ($root
    // -replace '[^A-Za-z0-9]', '_') — lossy character replacement, so two
    // DISTINCT roots that only differ in a replaced character (C:\wmux-a vs
    // C:\wmux_a) collapse onto the same mutex name and would block each
    // other's install. A SHA256 of the root is collision-resistant instead of
    // merely "usually fine."
    `$mtxHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($root))) -replace '-', ''`,
    `$mtxName = 'wmux-install-waiter-' + $mtxHash`,
    `$mtxCreated = $false`,
    `$mtx = New-Object System.Threading.Mutex -ArgumentList $true, $mtxName, ([ref]$mtxCreated)`,
    `if (-not $mtxCreated) { exit 5 }`,
    // #1056 — incumbent-only "interrupted" sentinel. From here this waiter
    // owns the outcome; if it dies without reaching a terminal (the app's
    // death tears down a containing job, a reboot mid-wait), the next boot
    // must not be silent. Every abort terminal below overwrites it, and both
    // success exits remove it — the cannot-judge exit included, since an
    // installer demonstrably launched and still running at the deadline makes
    // "interrupted" a false refusal (the same false-positive reasoning as the
    // #1043 newcomer-marker note above). Written BEFORE the WinForms block so
    // an Add-Type failure cannot eat it, and only AFTER the mutex so a
    // yielding newcomer (exit 5) cannot clobber the incumbent's outcome.
    `try { Set-Content -LiteralPath $marker -Value 'install-aborted: wmux quit to install the update, but the installer step was interrupted before it could report an outcome. Try again, or run the installer from the releases page.' -Encoding utf8 } catch { }`,
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
    // Colors match the app's own default dark chrome (the 'amber' theme in
    // themes.ts: bgMantle for panel surfaces, textMain for body text,
    // accentSecondary — steel-blue, the app's own "navigation/informational"
    // accent, not the amber "attention" one — for the header) rather than
    // stock Windows gray, so this reads as wmux's own UI and not a random
    // system dialog. Segoe UI at two weights does the rest: a bold "wmux"
    // header plus a lighter status line underneath.
    `$form = $null`,
    `$formsLoaded = $false`,
    `try {`,
    `  Add-Type -AssemblyName System.Windows.Forms`,
    `  $formsLoaded = $true`,
    `  Add-Type -AssemblyName System.Drawing`,
    `  $form = New-Object System.Windows.Forms.Form`,
    `  $form.Text = 'wmux update'`,
    `  $form.FormBorderStyle = 'FixedToolWindow'`,
    `  $form.StartPosition = 'CenterScreen'`,
    `  $form.TopMost = $true`,
    `  $form.ShowInTaskbar = $false`,
    `  $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#19191C')`,
    `  $form.ClientSize = New-Object System.Drawing.Size(380, 110)`,
    `  $headerLabel = New-Object System.Windows.Forms.Label`,
    `  $headerLabel.Text = 'wmux'`,
    `  $headerLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#6E9BC4')`,
    `  $headerLabel.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)`,
    `  $headerLabel.Dock = 'Top'`,
    `  $headerLabel.Height = 40`,
    `  $headerLabel.TextAlign = 'MiddleCenter'`,
    `  $label = New-Object System.Windows.Forms.Label`,
    `  $label.Text = "Installing the update...\`nThis window closes on its own."`,
    `  $label.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#EFEEEC')`,
    `  $label.Font = New-Object System.Drawing.Font('Segoe UI', 9)`,
    `  $label.Dock = 'Fill'`,
    `  $label.TextAlign = 'MiddleCenter'`,
    `  $form.Controls.Add($label)`,
    `  $form.Controls.Add($headerLabel)`,
    `  $form.Show()`,
    `  [System.Windows.Forms.Application]::DoEvents()`,
    // #1043, coderabbit: a throw partway through this block — after
    // .Show() but before the try finishes — used to leave a visible form
    // orphaned: the catch cleared $form to null, so every later `if ($form)`
    // cleanup treated it as never having existed and the window sat there,
    // topmost, until the waiter process itself exited. Close it first if it
    // got far enough to exist, THEN null the reference.
    `} catch { if ($form) { try { $form.Close() } catch { } }; $form = $null }`,
    // Capture HANDLES first. GetProcessById opens a handle now, so a later pid
    // recycle cannot make an exited process look alive (or a stranger's
    // process look like ours).
    `$handles = @()`,
    `foreach ($id in @(${pidList})) { try { $handles += [System.Diagnostics.Process]::GetProcessById($id) } catch { } }`,
    // #1084 — pids app.quit() already told to exit, with no flush to protect
    // (the daemon is never in this set — see AutoUpdater.ts). A hang here
    // gets a short grace window, then a kill, instead of riding the full
    // $budget below toward a refusal the user has to notice and clear by
    // hand.
    `$forceKillEligible = @(${eligibleList})`,
    `$graceBudget = ${plan.forceKillGraceMs}`,
    `function Stop-WaiterOwnedProcess($procId) {`,
    `  try { & (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID $procId /T /F 2>&1 | Out-Null } catch { }`,
    `}`,
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
    //
    // #1084 — an eligible handle's deadline is $graceBudget, not $budget, but
    // it is measured off the SAME shared clock as everything else (not a
    // fresh timer per handle): a handle reached late, after the clock has
    // already run past $graceBudget waiting on earlier ones, force-kills
    // immediately rather than getting a full grace window it did not need to
    // wait for. On expiry it force-kills and moves on WITHOUT setting
    // $stuck — that verdict stays reserved for a pid this waiter cannot end
    // itself.
    `$clock = [System.Diagnostics.Stopwatch]::StartNew()`,
    `$stuck = $false`,
    `foreach ($h in $handles) {`,
    `  $eligible = $forceKillEligible -contains $h.Id`,
    `  $deadline = if ($eligible) { [Math]::Min($graceBudget, $budget) } else { $budget }`,
    `  while ($true) {`,
    `    $left = $deadline - $clock.ElapsedMilliseconds`,
    `    if ($left -le 0) {`,
    `      if ($eligible) {`,
    `        Stop-WaiterOwnedProcess $h.Id`,
    `        try { $h.WaitForExit(2000) } catch { }`,
    `      } else {`,
    `        $stuck = $true`,
    `      }`,
    `      break`,
    `    }`,
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
    `$setupProc = $null`,
    `try { $setupProc = Start-Process -FilePath $setup -PassThru -ErrorAction Stop } catch { $started = $false }`,
    `if (-not $started) {`,
    `  Set-Content -LiteralPath $marker -Value 'install-aborted: the installer could not be started' -Encoding utf8`,
    `  exit 4`,
    `}`,
    // #1046 -- post-exit verification. A Squirrel install can throw partway
    // (field log: Defender's transient lock on the freshly written exe turned
    // a delete into UnauthorizedAccessException) and abort with the app dir
    // half-copied: wmux.exe present, icudtl.dat never written, Update.exe
    // never created. An app without icudtl.dat dies before one line of our
    // code runs, so no in-app check can ever fire on the machine that needs
    // it -- this waiter is the one process of ours still alive on the update
    // path, so it stays for the installer's exit and looks at what was left
    // behind. (A fresh install run by hand has no waiter; that half of #1046
    // stays open upstream.)
    //
    // Same fail-safe posture as the wait window above: verification can only
    // ADD a warning. An installer still running at the deadline means
    // "cannot judge" and exits 0 exactly like before, and so does a throw
    // anywhere in the checks.
    `$setupDone = $false`,
    `try { if ($setupProc) { $setupDone = $setupProc.WaitForExit(600000) } } catch { }`,
    `if (-not $setupDone) { Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue; exit 0 }`,
    // Newest app-* by write time is what the root stub will launch next. The
    // 30s poll absorbs an installer whose file work settles just after its
    // process tree exits -- the alarm only fires once the corpse is stable.
    `$verifyClock = [System.Diagnostics.Stopwatch]::StartNew()`,
    `$updateExeOk = $false`,
    `$icuOk = $false`,
    `while ($verifyClock.ElapsedMilliseconds -lt 30000) {`,
    `  $updateExeOk = Test-Path -LiteralPath (Join-Path $root 'Update.exe')`,
    `  $newestApp = $null`,
    `  try { $newestApp = Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 } catch { }`,
    `  $icuOk = ($null -ne $newestApp) -and (Test-Path -LiteralPath (Join-Path $newestApp.FullName 'icudtl.dat'))`,
    `  if ($updateExeOk -and $icuOk) { Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue; exit 0 }`,
    `  Start-Sleep -Milliseconds 1000`,
    `}`,
    `$missing = @()`,
    `if (-not $updateExeOk) { $missing += 'Update.exe' }`,
    `if (-not $icuOk) { $missing += 'icudtl.dat' }`,
    `$reason = 'install-aborted: the installer exited but left an incomplete installation (missing ' + ($missing -join ', ') + '). Reinstall wmux from the latest Setup.exe.'`,
    `try { Set-Content -LiteralPath $marker -Value $reason -Encoding utf8 } catch { }`,
    // The marker only helps if the app can still boot; when icudtl.dat is
    // what went missing, it cannot. This MessageBox is the only surface that
    // reaches that user -- best-effort, gated on the Forms assembly having
    // actually loaded for the wait window earlier.
    `if ($formsLoaded) { try { [System.Windows.Forms.MessageBox]::Show('The wmux update did not complete: ' + ($missing -join ', ') + ' is missing from the installation, and wmux may no longer start. Please reinstall from the latest Setup.exe (github.com/openwong2kim/wmux/releases).', 'wmux update', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null } catch { } }`,
    `exit 6`,
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
 * #1056 — bounded poll for the waiter's heartbeat, written as the first line
 * of the script (see buildWaiterScript). The caller awaits this BEFORE
 * `onInstallRequiresFullShutdown()` and the force-kill, so a waiter that never
 * ran costs nothing: nothing has been torn down yet and the old install is
 * untouched.
 *
 * `existsFn` and `sleepFn` are injected so the unit suite can resolve this in
 * milliseconds instead of burning the real budget.
 */
export async function waitForWaiterHeartbeat(
  markerPath: string,
  budgetMs: number,
  pollMs = 100,
  existsFn: (p: string) => boolean = fs.existsSync,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (existsFn(markerPath)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return existsFn(markerPath);
    await sleepFn(Math.min(pollMs, left));
  }
}

/**
 * Sync sleep for the launch-stamp gate below. Atomics.wait cannot be assumed
 * blockable on every agent — a TypeError here would land in
 * spawnInstallWaiter's outer catch and turn into a UNIVERSAL install refusal,
 * a worse bug than the one this file fixes — so each step degrades to a
 * bounded busy-wait instead of propagating (#1056 review P1-A).
 */
function sleepStepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* bounded busy-wait fallback */ }
  }
}

/**
 * Attach a no-op 'error' handler to a spawned waiter transport.
 *
 * `spawn` reports a failure to create the process ASYNCHRONOUSLY, by emitting
 * 'error' on the returned ChildProcess — the synchronous try/catch around the
 * call does NOT cover it. An 'error' event with no listener is re-thrown by
 * EventEmitter as an uncaught exception, which in the main process means a
 * crash at the single worst moment available: mid install-handoff, after the
 * app has committed to quitting. The transport gate already treats "no launch
 * stamp" as failure, so there is nothing for a handler to decide here — its
 * only job is to keep the failure a fall-through instead of a crash.
 *
 * The listener must be attached BEFORE unref(): unref only stops the child
 * from holding the event loop open, it does not stop the emit.
 */
function swallowSpawnError(child: ChildProcess): void {
  child.on('error', () => { /* the launch-stamp gate is the real verdict */ });
}

/** True once `stampPath` exists, polling every 50ms up to `budgetMs`. */
function waitForLaunchStamp(stampPath: string, budgetMs: number): boolean {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { if (fs.existsSync(stampPath)) return true; } catch { /* probe again */ }
    if (Date.now() >= deadline) return false;
    sleepStepMs(50);
  }
}

// #1056 launch-verification budgets. A is generous on purpose: its critical
// path is cmd.exe start + a PS 5.1 engine cold start + AMSI/Defender scanning
// a freshly written .ps1 in TEMP — and the AV-heavy machines where that is
// slow are exactly the machines this transport exists for; misreading a
// working trampoline as dead falls through to a transport known to die on
// those same machines. B is short: same engine init, no cmd, and it only
// runs after A already burned its window. Total ≤8s of synchronous wait, and
// nothing is armed yet — the 20s before-quit deadline only exists once the
// caller reaches app.quit().
// #1136 adds W ahead of both. Same generosity as A, and for the same reason:
// its critical path is a wscript host start plus the same PS 5.1 cold start
// and AMSI scan of a freshly written .ps1. Measured on a Win11 box with
// Windows Terminal as the default host, W stamps in ~440ms (A: ~585ms), so
// the budget is >10x the observed cost; it is only ever spent in full on a
// machine where WSH is disabled by policy, and there `//B` makes wscript fail
// fast and silently rather than pop a dialog. Worst case is now three burned
// windows (~14s) before the refusal instead of two (~8s) — paid only on the
// path that was already going to end in a refusal dialog, and nothing is
// armed yet (the 20s before-quit deadline starts at app.quit()).
const LAUNCH_STAMP_BUDGET_W_MS = 6_000;
const LAUNCH_STAMP_BUDGET_A_MS = 6_000;
const LAUNCH_STAMP_BUDGET_B_MS = 2_000;

/**
 * Write the waiter to a temp directory and start it so that it PROVABLY runs.
 *
 * The script deliberately does NOT live under the install root: Setup.exe
 * deletes that root, and a waiter inside it would be deleting itself while
 * running. Returns the launched script's path on success, null when no
 * transport could be verified — and a null MUST make the caller abandon the
 * install rather than fall back to launching Setup.exe directly.
 *
 * #1056 — "started" is not something a spawn can promise here. On current
 * Windows builds (measured on two real machines: the reporter's and this
 * one), a PowerShell spawned DIRECTLY with `detached: true` dies before
 * executing its first line — engine event 40961 with no 40962, exit 0,
 * nothing on stderr, no AV detection — while the same PowerShell created by
 * a detached cmd.exe survives and runs to completion. So:
 *
 *   transport W — #1136, PREFERRED. wscript.exe (GUI subsystem, so it never
 *       touches the Win11 default-terminal delegation that made the cmd.exe
 *       trampoline flash a visible Windows Terminal window) running a VBS
 *       one-liner that starts the same PowerShell hidden and waits on it.
 *       See buildWaiterVbsLauncher for the measured root cause.
 *   transport A — cmd.exe trampoline. argv-array: libuv does the CRT
 *       quoting, and cmd /c's strip-first-and-last-quote rule cannot fire
 *       because the first token after /c (the System32 powershell path)
 *       carries no spaces and is unquoted. Kept unchanged as the fallback for
 *       machines where Windows Script Host is disabled by policy — visible
 *       window and all, because a visible window is a cosmetic defect and a
 *       refused install is not.
 *   transport B — today's direct detached spawn, kept for machines where A
 *       is somehow unavailable but the direct spawn still works.
 *   Both with cwd pinned OUTSIDE the install root — an inherited cwd inside
 *       it would hold the directory open in a way the lock probe (file locks
 *       only) can never see.
 *
 * Each transport must PROVE execution: the waiter's first statement writes a
 * launch stamp — a distinct file per transport, so a late A stamp can never
 * be misattributed to B and the transport log cannot lie — and the gate
 * polls for it. The trampoline's cost is one idle cmd.exe parked as the
 * waiter's parent for its lifetime (up to ~11 min); it lives in System32 and
 * holds nothing under the install root.
 */
export function spawnInstallWaiter(plan: WaiterPlan): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-install-waiter-'));
    const stampW = path.join(dir, 'launched-w.txt');
    const stampA = path.join(dir, 'launched-a.txt');
    const stampB = path.join(dir, 'launched-b.txt');
    const scriptW = buildWaiterScript(plan, stampW);
    const scriptA = buildWaiterScript(plan, stampA);
    const scriptB = buildWaiterScript(plan, stampB);
    if (!scriptW || !scriptA || !scriptB) return null;
    const scriptPathW = path.join(dir, 'wait-and-install-w.ps1');
    const scriptPathA = path.join(dir, 'wait-and-install.ps1');
    const scriptPathB = path.join(dir, 'wait-and-install-b.ps1');
    // The BOM is load-bearing. Windows PowerShell 5.1 decodes a BOM-less file
    // as the system ANSI code page, so on a Korean install every path we
    // embedded — all of them under the user profile — comes back mangled.
    // Measured: with `C:\Users\홍길동\...` the BOM-less script still exits 0
    // while writing to the wrong path, which is the worst shape a failure can
    // take here (silent success). With the BOM it behaves.
    fs.writeFileSync(scriptPathW, '\uFEFF' + scriptW, 'utf-8');
    fs.writeFileSync(scriptPathA, '\uFEFF' + scriptA, 'utf-8');
    fs.writeFileSync(scriptPathB, '\uFEFF' + scriptB, 'utf-8');

    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
    const spawnedPids: number[] = [];
    // Named per transport rather than indexed off spawnedPids: with three
    // transports an index is a silent mis-attribution waiting to happen, and
    // this log line is the field evidence for which one carried the install.
    let pidW: number | undefined;
    let pidA: number | undefined;
    let pidB: number | undefined;
    let spawnedA = false;
    let spawnedB = false;

    // #1136 — transport W, tried first because it is the only one that stays
    // invisible under the Win11 default-terminal delegation.
    const vbs = buildWaiterVbsLauncher(powershell, psArgs, scriptPathW);
    if (vbs !== null) {
      // UTF-16LE with a BOM, for the same reason scriptA/B carry one: a
      // BOM-less script is decoded as the system ANSI code page, and every
      // path embedded here (TEMP, so the user profile) mangles on a non-Latin
      // install — the silent-wrong-path failure #1056 already paid for once.
      // wscript reads UTF-16LE unambiguously.
      const vbsPath = path.join(dir, 'launch-waiter.vbs');
      let spawnedW = false;
      try {
        fs.writeFileSync(vbsPath, '\uFEFF' + vbs, 'utf16le');
        const w = spawn(
          path.join(systemRoot, 'System32', 'wscript.exe'),
          // //B: batch mode. Without it a machine with Windows Script Host
          // disabled by policy shows an error DIALOG — the exact class of
          // visible window this transport exists to remove. With it, wscript
          // fails silently and the gate falls through to transport A.
          ['//B', '//Nologo', vbsPath],
          { detached: true, stdio: 'ignore', windowsHide: true, cwd: systemRoot },
        );
        swallowSpawnError(w);
        w.unref();
        spawnedW = true;
        if (typeof w.pid === 'number') { spawnedPids.push(w.pid); pidW = w.pid; }
      } catch { /* WSH unavailable — A still gets its window */ }
      // Only poll for a stamp a process was actually asked to write. Without
      // this gate a spawn that threw still burned the full 6s budget waiting
      // on a file nothing could ever create, delaying the fallback transports
      // for no information.
      if (spawnedW && waitForLaunchStamp(stampW, LAUNCH_STAMP_BUDGET_W_MS)) {
        console.log(`[installTeardown] waiter verified via hidden wscript launcher (pid ${pidW ?? '?'}): ${scriptPathW}`);
        return scriptPathW;
      }
    }

    try {
      const a = spawn(
        'cmd.exe',
        ['/d', '/c', powershell, ...psArgs, scriptPathA],
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: systemRoot },
      );
      swallowSpawnError(a);
      a.unref();
      spawnedA = true;
      if (typeof a.pid === 'number') { spawnedPids.push(a.pid); pidA = a.pid; }
    } catch { /* transport A unavailable — B still gets its window */ }
    if (spawnedA && waitForLaunchStamp(stampA, LAUNCH_STAMP_BUDGET_A_MS)) {
      console.log(`[installTeardown] waiter verified via cmd trampoline (pid ${pidA ?? '?'}): ${scriptPathA}`);
      return scriptPathA;
    }

    try {
      const b = spawn(
        powershell,
        [...psArgs, scriptPathB],
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: systemRoot },
      );
      swallowSpawnError(b);
      b.unref();
      spawnedB = true;
      if (typeof b.pid === 'number') { spawnedPids.push(b.pid); pidB = b.pid; }
    } catch { /* fall through to the refusal below */ }
    if (spawnedB && waitForLaunchStamp(stampB, LAUNCH_STAMP_BUDGET_B_MS)) {
      console.log(`[installTeardown] waiter verified via direct spawn (pid ${pidB ?? '?'}): ${scriptPathB}`);
      return scriptPathB;
    }

    // Neither transport proved execution — refuse. P1-B: a slow-but-alive
    // waiter left behind now would double-report (its interrupted sentinel
    // plus a later exit-3 marker) and park a TopMost wait window over a wmux
    // the user is still using, so both attempts are tree-killed (the /T
    // reaches the PS under the cmd parent) and whatever they already wrote
    // is cleared. Kill before clear: a residual race is acceptable, a
    // guaranteed double-report is not.
    console.warn('[installTeardown] no waiter transport proved execution — refusing the install handoff (#1056)');
    terminatePids(spawnedPids);
    clearAbortMarker(plan.abortMarkerPath);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return null;
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
