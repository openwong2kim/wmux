/**
 * Post-install reconcile: finish the Squirrel install hook's work when the
 * hook was cancelled before it got there.
 *
 * Squirrel runs `wmux.exe --squirrel-install` and cancels it after ~15 s.
 * Most of that budget can be gone before a line of our code runs: the exe was
 * written a moment earlier, and antivirus scans it on first execution.
 * Measured on one Windows 11 box (2026-09-28, Defender + Smart App Control),
 * the hook process started 5 s, 6 s, and more than 18 s after Squirrel launched
 * it, and the hook was cancelled in 4 of 5 installs. A cancelled hook leaves
 * no `wmux` CLI shim or PATH entry, no Run value (autostart), and no
 * Desktop/Start Menu shortcut. Nothing reports it; Squirrel only logs
 * "Couldn't run Squirrel hook, continuing".
 *
 * Squirrel launches `wmux.exe --squirrel-firstrun` after every install,
 * cancelled hook or not, so that launch is a reliable signal that an install
 * just happened. The normal app boot (firstrun or not) runs this reconcile
 * after the window is up, and it redoes whatever is missing:
 *
 *   - CLI shim: whenever `<root>\bin\wmux.cmd` is missing or `<root>\bin` is
 *     not on PATH. The installer wipes the whole root, `bin\` included, so a
 *     missing shim means the hook never reached it; a present shim without the
 *     PATH entry means it stopped in between. Uninstall removes both, but no
 *     app is running after an uninstall.
 *   - Autostart: a Run value whose target no longer exists (it names the
 *     versioned `app-X.Y.Z\wmux.exe`, which the next install deletes) is
 *     pointed at the running exe. A MISSING value is only created on the
 *     firstrun of a fresh install (no session.json yet). The same absence on an
 *     existing profile may be the user's opt-out, and must stick.
 *   - Shortcuts: only on the firstrun of a fresh install, and only the
 *     locations that are missing. A user who deleted a shortcut must not see
 *     it come back on the next update.
 *
 * The decision is a pure function (`planPostInstallReconcile`) so it is unit
 * tested directly; `runPostInstallReconcile` is the thin OS layer, win32-only
 * and best-effort. It never throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import * as autostart from './autostart';
import * as cliShim from './cliShim';
import * as shortcutHygiene from './shortcutHygiene';
import { squirrelInstallRootFor } from './updater/installIntegrity';

export type ShortcutLocation = 'Desktop' | 'StartMenu';

export interface ReconcileProbe {
  /** Launched with `--squirrel-firstrun`: an install finished moments ago. */
  firstRun: boolean;
  /** No session.json existed when this boot started: nobody has used wmux on this profile. */
  freshInstall: boolean;
  /** `<root>\bin\wmux.cmd` exists. */
  shimExists: boolean;
  /** `<root>\bin` is on this process's PATH (the hook can stop between writing the shim and editing PATH). */
  binOnPath: boolean;
  /** Target of the Run value, or null when there is no value. */
  autostartTarget: string | null;
  /** Whether `autostartTarget` exists on disk (ignored when the target is null). */
  autostartTargetExists: boolean;
  desktopShortcutExists: boolean;
  startMenuShortcutExists: boolean;
}

export interface ReconcilePlan {
  installCliShim: boolean;
  /** 'enable' creates a missing value; 'retarget' repoints a dead one. */
  autostart: 'enable' | 'retarget' | null;
  shortcuts: ShortcutLocation[];
}

/** Pure decision. See the module header for why each rule is gated the way it is. */
export function planPostInstallReconcile(probe: ReconcileProbe): ReconcilePlan {
  const freshFirstRun = probe.firstRun && probe.freshInstall;

  let autostartAction: ReconcilePlan['autostart'] = null;
  if (probe.autostartTarget === null) {
    if (freshFirstRun) autostartAction = 'enable';
  } else if (!probe.autostartTargetExists) {
    autostartAction = 'retarget';
  }

  const shortcuts: ShortcutLocation[] = [];
  if (freshFirstRun) {
    if (!probe.desktopShortcutExists) shortcuts.push('Desktop');
    if (!probe.startMenuShortcutExists) shortcuts.push('StartMenu');
  }

  return { installCliShim: !probe.shimExists || !probe.binOnPath, autostart: autostartAction, shortcuts };
}

/**
 * Whether a Run value target still resolves. Only the `app-X.Y.Z\wmux.exe`
 * tail is trusted, and it is checked under OUR install root: reg.exe prints in
 * the OEM code page, so a profile path with non-ASCII characters comes back
 * garbled, and comparing the whole path would "retarget" on every boot. A
 * value that does not name an `app-*` exe is not one we wrote, so it reports
 * alive and is left alone. Pure apart from one stat; exported for tests.
 */
export function autostartTargetAlive(target: string, root: string): boolean {
  const m = /[\\/](app-[^\\/]+)[\\/]wmux\.exe$/i.exec(target);
  if (!m) return true;
  return fs.existsSync(path.join(root, m[1], 'wmux.exe'));
}

/**
 * Whether `binDir` is an entry of a Windows PATH string (case-insensitive,
 * trailing separators ignored). The app inherits PATH from Explorer, which
 * picks up the hook's edit through its WM_SETTINGCHANGE broadcast. A stale
 * Explorer only costs one no-op PATH edit per boot until the next sign-in:
 * the edit script exits without writing when the entry is already there.
 */
export function isOnPath(binDir: string, pathValue: string | undefined): boolean {
  const want = binDir.replace(/[\\/]+$/, '').toLowerCase();
  return (pathValue ?? '').split(';').some((p) => p.trim().replace(/[\\/]+$/, '').toLowerCase() === want);
}

export function isEmptyPlan(plan: ReconcilePlan): boolean {
  return !plan.installCliShim && plan.autostart === null && plan.shortcuts.length === 0;
}

/**
 * `Update.exe --createShortcut` waits this long after the reconcile starts.
 * On firstrun the installer's own Update.exe is still finishing, and
 * `squirrel.exe --updateSelf` overwrites `<root>\Update.exe` a few seconds
 * after it exits (measured: firstrun at +0 s, installer exit +1.3 s, root
 * Update.exe replaced +3.2 s). Launching the root Update.exe inside that
 * window could hold it open while it is being replaced.
 */
const SHORTCUT_DELAY_MS = 30_000;

/** Squirrel's Start Menu link lives in `Programs\<author>\`; <=3.3.x wrote it at the top level. */
function startMenuShortcutExists(appData: string): boolean {
  const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  if (fs.existsSync(path.join(programs, 'wmux.lnk'))) return true;
  try {
    return fs.readdirSync(programs, { withFileTypes: true })
      .some((d) => d.isDirectory() && fs.existsSync(path.join(programs, d.name, 'wmux.lnk')));
  } catch {
    return false;
  }
}

/**
 * `desktopDir` comes from app.getPath('desktop') so a Desktop redirected by
 * OneDrive is checked where Squirrel actually writes the link.
 */
function desktopShortcutExists(desktopDir: string | undefined): boolean {
  if (!desktopDir) return true; // unknown: never create what we cannot check for
  return fs.existsSync(path.join(desktopDir, 'wmux.lnk'));
}

function createShortcuts(execPath: string, root: string, locations: ShortcutLocation[]): void {
  const updateExe = path.join(root, 'Update.exe');
  if (!fs.existsSync(updateExe)) {
    console.warn('[postInstall] shortcuts not created: Update.exe is missing');
    return;
  }
  const icon = shortcutHygiene.stageRootIcon(execPath);
  const args = ['--createShortcut', path.basename(execPath), '--shortcut-locations', locations.join(',')];
  if (icon) args.push('--icon', icon);
  const child = spawn(updateExe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => console.warn('[postInstall] Update.exe --createShortcut failed:', err));
  child.unref();
}

/**
 * True when no session.json exists yet: nobody has used wmux on this profile.
 * Must be read before the boot's first session save creates the file.
 */
export function isFreshProfile(userDataDir: string): boolean {
  return !fs.existsSync(path.join(userDataDir, 'session.json'));
}

export interface ReconcileOptions {
  execPath: string;
  firstRun: boolean;
  freshInstall: boolean;
  desktopDir?: string;
}

/**
 * Probe, plan, act. win32-only; returns the plan it acted on (null when the
 * layout is not a Squirrel install or the probe failed). Never throws.
 */
export async function runPostInstallReconcile(opts: ReconcileOptions): Promise<ReconcilePlan | null> {
  if (process.platform !== 'win32') return null;
  try {
    const root = squirrelInstallRootFor(opts.execPath);
    if (!root) return null;
    const appData = process.env.APPDATA;
    if (!appData) return null;

    const target = autostart.readAutostartTarget();
    const plan = planPostInstallReconcile({
      firstRun: opts.firstRun,
      freshInstall: opts.freshInstall,
      shimExists: fs.existsSync(path.join(root, 'bin', 'wmux.cmd')),
      binOnPath: isOnPath(path.join(root, 'bin'), process.env.PATH ?? process.env.Path),
      autostartTarget: target,
      autostartTargetExists: target !== null && autostartTargetAlive(target, root),
      desktopShortcutExists: desktopShortcutExists(opts.desktopDir),
      startMenuShortcutExists: startMenuShortcutExists(appData),
    });
    if (isEmptyPlan(plan)) return plan;

    console.log(
      `[postInstall] install hook work missing, redoing: shim=${plan.installCliShim} ` +
        `autostart=${plan.autostart ?? 'none'} shortcuts=${plan.shortcuts.join(',') || 'none'}`,
    );
    if (plan.autostart) autostart.enableAutostart(opts.execPath);
    if (plan.shortcuts.length > 0) {
      const locations = plan.shortcuts;
      setTimeout(() => {
        try { createShortcuts(opts.execPath, root, locations); } catch { /* best-effort */ }
      }, SHORTCUT_DELAY_MS).unref();
    }
    if (plan.installCliShim) await cliShim.installCliShimAsync(opts.execPath);
    return plan;
  } catch (err) {
    console.warn('[postInstall] reconcile failed (non-fatal):', err);
    return null;
  }
}
