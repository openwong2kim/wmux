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
 *            (no --type=, no daemon script, no --squirrel-* flag)
 *   spared:  ourselves (the hook process), Chromium helper children
 *            (--type=..., they die with their parent's tree-kill), the wmux
 *            daemon (it holds the user's live PTY sessions — the persistence
 *            promise; the B′ stale-daemon replacement upgrades it on the
 *            next app boot), and any concurrent Squirrel hook process
 *            (e.g. the old exe running --squirrel-obsolete, or the fresh
 *            post-install --squirrel-firstrun launch).
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
    rows.push({ pid, commandLine: typeof o.CommandLine === 'string' ? o.CommandLine : '' });
  }
  return rows;
}

/**
 * Kill every running GUI app instance of this exe (tree-kill, so its
 * renderer/GPU helpers go with it). Returns the PIDs actually killed.
 * win32-only; every step is best-effort — enumeration or kill failures
 * return what succeeded rather than throwing into the installer hook.
 */
export function terminateRunningAppInstances(): number[] {
  if (process.platform !== 'win32') return [];
  const exeName = path.basename(process.execPath);
  // The name lands inside a CIM filter string — refuse anything that could
  // escape the quoting rather than attempting to sanitize it.
  if (!/^[\w][\w .-]*\.exe$/i.test(exeName) || exeName.includes("'")) return [];

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  let stdout: string;
  try {
    stdout = execFileSync(
      powershell,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" -ErrorAction SilentlyContinue | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true },
    );
  } catch {
    return [];
  }

  const targets = selectAppInstancePids(parseCimProcessJson(stdout), process.pid);
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
  return killed;
}
