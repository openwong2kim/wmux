/**
 * Squirrel.Windows installer-time teardown of running app instances (#502).
 *
 * Running a new-version Setup.exe while wmux was still open crashed the
 * updater: Update.exe's post-extract work (shortcut creation, old-version
 * cleanup) collides with the live instance's locked exe/resources, and the
 * post-install relaunch dies against the old instance's single-instance
 * lock — leaving the user on the OLD version even when the file copy half
 * succeeded. The old, already-shipped app cannot be fixed retroactively,
 * but the installer hooks (--squirrel-install / -updated / -uninstall) run
 * the NEW exe's code — so the hook process takes the running instance down
 * before any Update.exe work proceeds.
 *
 * There is no graceful remote quit to use: released pipe servers expose only
 * system.identify/system.capabilities (no quit RPC), and WM_CLOSE is
 * intercepted as hide-to-tray. So this is a force-kill, scoped as narrowly
 * as classification allows:
 *
 *   killed:  GUI app instances — our exe image with a plain command line
 *            (no --type=, no daemon script, no --squirrel-* flag) — and
 *            every process descended from one (Chromium helpers, local
 *            shells, other children), each by pid
 *   spared:  ourselves (the hook process), the wmux daemon and everything
 *            under it (it holds the user's live PTY sessions — the
 *            persistence promise; the B′ stale-daemon replacement upgrades it
 *            on the next app boot), and any concurrent Squirrel hook process
 *            (e.g. the old exe running --squirrel-obsolete, or the fresh
 *            post-install --squirrel-firstrun launch).
 *
 * No `taskkill /T` on an app (#3007): the app spawns the daemon, so the
 * daemon's parent pid is the app and a tree kill of the app takes the daemon
 * and its shells with it. taskkill has no way to exclude a pid from /T, so
 * the tree is walked here, pruned at the daemon, and killed pid by pid.
 *
 * Session-state risk is accepted: the renderer persists layout synchronously
 * on every change and PTYs live in the daemon, so a force-kill loses at most
 * the final best-effort flush — versus the status quo of a crashed installer.
 *
 * Classification + CIM-JSON parsing are pure and unit-tested directly (the
 * squirrel.ts pattern); only terminateRunningAppInstances touches the OS
 * (win32-only, best-effort, never throws — a kill failure must never block
 * the install itself).
 */
import * as path from 'path';
import { execFileSync } from 'child_process';

export type WmuxProcessKind = 'self' | 'helper' | 'daemon' | 'squirrel-hook' | 'app';

export interface WmuxProcessRow {
  pid: number;
  commandLine: string;
  /** Set when the query selected ParentProcessId; 0 when unreadable. */
  parentPid?: number;
  /** Set when the query selected Name (the image file name). */
  name?: string;
}

// Matches every daemon-script layout spawnDaemon() probes (launcher.ts):
// daemon-bundle\index.js, daemon\daemon\index.js, daemon\index.js — either
// slash direction. The daemon is `wmux.exe <script.js>` via
// ELECTRON_RUN_AS_NODE, so the script path in the command line is the
// discriminator (same rule the launcher's verified-kill path uses).
const DAEMON_SCRIPT_RE = /daemon(-bundle)?[\\/](daemon[\\/])?index\.js/i;

/**
 * Classify one same-image process row. Order matters: self before everything
 * (our own command line carries --squirrel-*), helpers before daemon (a
 * helper's long cmdline could contain almost anything), and the --squirrel
 * check last-but-one so a concurrent hook or the fresh --squirrel-firstrun
 * launch is never treated as a killable app instance.
 */
export function classifyWmuxProcess(row: WmuxProcessRow, ownPid: number): WmuxProcessKind {
  if (row.pid === ownPid) return 'self';
  const cmd = row.commandLine;
  if (cmd.includes('--type=')) return 'helper';
  if (DAEMON_SCRIPT_RE.test(cmd)) return 'daemon';
  if (cmd.includes('--squirrel')) return 'squirrel-hook';
  return 'app';
}

/** PIDs of running GUI app instances — the only kill targets. */
export function selectAppInstancePids(rows: readonly WmuxProcessRow[], ownPid: number): number[] {
  return rows
    .filter((row) => classifyWmuxProcess(row, ownPid) === 'app')
    .map((row) => row.pid);
}

/**
 * Parse `Get-CimInstance ... | ConvertTo-Json -Compress` output into rows.
 * ConvertTo-Json emits a bare object for a single match and an array for
 * several; no match yields empty output. CommandLine can be null (access
 * denied / exited mid-query) — treated as '' so the row still classifies
 * (an unreadable cmdline falls through to 'app'; killing our own image with
 * an unreadable cmdline is the safe default for an installer that must not
 * leave the old instance running).
 */
export function parseCimProcessJson(stdout: string): WmuxProcessRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const rows: WmuxProcessRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const pid = typeof o.ProcessId === 'number' ? o.ProcessId : NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const row: WmuxProcessRow = { pid, commandLine: typeof o.CommandLine === 'string' ? o.CommandLine : '' };
    // A missing or malformed parent reads as 0, which belongs to no tree.
    if ('ParentProcessId' in o) {
      const parent = o.ParentProcessId;
      row.parentPid = typeof parent === 'number' && Number.isInteger(parent) && parent > 0 ? parent : 0;
    }
    if ('Name' in o) row.name = typeof o.Name === 'string' ? o.Name : '';
    rows.push(row);
  }
  return rows;
}

/**
 * What the install hook kills, from a full process table (#3007): the GUI app
 * instances of `exeName`, then every process descended from one. The walk is
 * pruned at the daemon (its parent pid is the app), at ourselves and at any
 * concurrent Squirrel hook, so none of those, nor anything under them, is
 * killed. The prune applies whatever the image name: sparing a daemon-shaped
 * process is the safe direction.
 */
export function selectAppTreeKillPids(
  rows: readonly WmuxProcessRow[],
  ownPid: number,
  exeName: string,
): { appPids: number[]; descendantPids: number[] } {
  const image = exeName.toLowerCase();
  const appPids = selectAppInstancePids(
    rows.filter((row) => (row.name ?? '').toLowerCase() === image),
    ownPid,
  );
  const childrenOf = new Map<number, WmuxProcessRow[]>();
  for (const row of rows) {
    const parent = row.parentPid ?? 0;
    if (parent <= 0) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(row);
    else childrenOf.set(parent, [row]);
  }
  // `seen` doubles as the cycle guard: Windows recycles pids, so a stale
  // parent reference can close a loop.
  const seen = new Set<number>(appPids);
  const descendantPids: number[] = [];
  const queue = [...appPids];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const kind = classifyWmuxProcess(child, ownPid);
      if (kind === 'daemon' || kind === 'self' || kind === 'squirrel-hook') continue;
      descendantPids.push(child.pid);
      queue.push(child.pid);
    }
  }
  return { appPids, descendantPids };
}

/** taskkill arguments for one pid. Never /T: see the header (#3007). */
export function forceKillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/F'];
}

/**
 * PIDs of daemons running from a staged runtime copy under `stageRoot`
 * (daemonRuntimeStage.ts). Only an uninstall stops them: the copy lives
 * outside the install, so Squirrel's own kill no longer reaches them.
 */
export function selectStagedDaemonPids(rows: readonly WmuxProcessRow[], ownPid: number, stageRoot: string): number[] {
  const norm = (p: string): string => p.replace(/\//g, '\\').toLowerCase();
  const root = norm(stageRoot).replace(/\\+$/, '') + '\\';
  return rows
    .filter((row) => classifyWmuxProcess(row, ownPid) === 'daemon' && norm(row.commandLine).includes(root))
    .map((row) => row.pid);
}

/**
 * Kill every running GUI app instance of this exe, then its descendants other
 * than the daemon's subtree (selectAppTreeKillPids). The app goes first so it
 * cannot respawn a helper. Returns the app PIDs actually killed.
 * win32-only; every step is best-effort — enumeration or kill failures
 * return what succeeded rather than throwing into the installer hook.
 */
export function terminateRunningAppInstances(): number[] {
  if (process.platform !== 'win32') return [];
  const exeName = path.basename(process.execPath);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  // The whole table, not just our image: a tree kill also reached the app's
  // non-wmux children (local shells, browsers, workers), and so must this.
  const rows = listProcesses(systemRoot, '', 'ProcessId,ParentProcessId,Name,CommandLine');
  if (!rows) return [];
  const { appPids, descendantPids } = selectAppTreeKillPids(rows, process.pid, exeName);
  const killed = appPids.filter((pid) => forceKill(systemRoot, pid));
  for (const pid of descendantPids) forceKill(systemRoot, pid);
  return killed;
}

/**
 * Uninstall only: stop the daemons running from staged copies under
 * `stageRoot`. Returns every daemon found, whether or not its kill succeeded,
 * so the caller waits on each one; null when the processes could not be
 * listed, which must not be read as "no daemon".
 */
export function terminateStagedDaemons(stageRoot: string): number[] | null {
  return terminateSameImage((rows) => selectStagedDaemonPids(rows, process.pid, stageRoot))?.found ?? null;
}

/** null: the processes could not be listed. */
function terminateSameImage(select: (rows: WmuxProcessRow[]) => number[]): { found: number[]; killed: number[] } | null {
  if (process.platform !== 'win32') return { found: [], killed: [] };
  const exeName = path.basename(process.execPath);
  // The name lands inside a CIM filter string — refuse anything that could
  // escape the quoting rather than attempting to sanitize it.
  if (!/^[\w][\w .-]*\.exe$/i.test(exeName) || exeName.includes("'")) return null;

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const rows = listProcesses(systemRoot, ` -Filter "Name='${exeName}'"`, 'ProcessId,CommandLine');
  if (!rows) return null;

  const targets = select(rows);
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  const killed: number[] = [];
  for (const pid of targets) {
    try {
      execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
        timeout: 10_000,
        windowsHide: true,
        stdio: 'ignore',
      });
      killed.push(pid);
    } catch {
      /* best-effort — a survivor is no worse than the pre-fix status quo */
    }
  }
  return { found: targets, killed };
}

/** null: the processes could not be listed. */
function listProcesses(systemRoot: string, filter: string, fields: string): WmuxProcessRow[] | null {
  const powershell = path.join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  let stdout: string;
  try {
    stdout = execFileSync(
      powershell,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process${filter} -ErrorAction Stop | Select-Object ${fields} | ConvertTo-Json -Compress`,
      ],
      // The full table with command lines can pass the 1 MB default.
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // -ErrorAction Stop: a failed query exits nonzero and lands here, while a
    // filter that matches nothing is empty output.
    return null;
  }
  if (stdout.trim()) {
    try { JSON.parse(stdout); } catch { return null; }
  }
  return parseCimProcessJson(stdout);
}

/** Best-effort single-pid kill; true when taskkill reported success. */
function forceKill(systemRoot: string, pid: number): boolean {
  try {
    execFileSync(path.join(systemRoot, 'System32', 'taskkill.exe'), forceKillArgs(pid), {
      timeout: 10_000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch {
    /* best-effort — already gone, or a survivor no worse than before */
    return false;
  }
}
