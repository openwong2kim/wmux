/**
 * #1046 — surface a half-completed Squirrel installation.
 *
 * Field log (2026-08-26): Windows Defender held a transient lock on the
 * freshly written 213 MB wmux.exe while scanning it, a delete inside
 * Squirrel's installer turned into UnauthorizedAccessException, and the
 * install aborted mid-copy. What that leaves behind splits into two classes:
 *
 *   1. Dead on arrival — `icudtl.dat` never got copied, so Chromium's ICU
 *      init fails before a single line of our code runs. NO in-app check can
 *      ever fire on that machine, by definition. The update path of this
 *      class is covered where a process of ours is still alive to look: the
 *      install waiter's post-exit verification (installTeardown.ts). The
 *      fresh-install path has no process of ours at all and stays open
 *      upstream (Squirrel retry / code signing).
 *
 *   2. Runs, but can never update or uninstall — the app dir copied far
 *      enough to boot, but `Update.exe` (written near the END of a
 *      successful install, alongside shortcut/icon work) never appeared.
 *      Every later in-app update fails, and Windows' own uninstall entry
 *      points at the missing Update.exe. Nothing said why. THIS module is
 *      that check: it runs on every boot, costs one stat, and turns a
 *      forever-silent breakage into one explicit message.
 *
 * The path helpers use `path.win32` explicitly: the layout being detected is
 * Windows-only, and the pure functions must behave identically under the
 * cross-platform test matrix.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * The Squirrel install root for an executable, or null when the layout does
 * not match. Squirrel runs the app out of `<root>\app-<version>\wmux.exe`,
 * so the parent directory's `app-` prefix is the discriminator — a dev run
 * (`node_modules\electron\dist\electron.exe`), a portable copy in an
 * arbitrary folder, and every non-Windows layout all fall out here.
 */
export function squirrelInstallRootFor(execPath: string): string | null {
  const w = path.win32;
  if (!/\.exe$/i.test(w.basename(execPath))) return null;
  const appDir = w.dirname(execPath);
  if (!/^app-/i.test(w.basename(appDir))) return null;
  const root = w.dirname(appDir);
  // `app-…` directly under a drive root would make root === appDir's parent
  // degenerate ('C:\\'); still a valid answer, so no further filtering.
  return root;
}

export interface InstallIntegrityGap {
  root: string;
  missing: string[];
}

/**
 * Pure check: given the running executable's path, is the installation it
 * came from missing pieces a complete Squirrel install always has?
 *
 * Only `Update.exe` is checked. Everything the RUNNING app already proves by
 * running (the exe itself, ICU data, resources) cannot be missing here, and
 * probing deeper (locales, asar) would turn a one-stat boot check into a
 * scan with its own false-positive surface.
 */
export function findInstallIntegrityGap(
  execPath: string,
  exists: (p: string) => boolean = (p) => {
    try { return fs.existsSync(p); } catch { return false; }
  },
): InstallIntegrityGap | null {
  const root = squirrelInstallRootFor(execPath);
  if (root === null) return null;
  const missing: string[] = [];
  // A probe that THROWS is "cannot verify", not "missing": the only thing a
  // gap produces is a warning, so unknown must never alarm.
  let updateExePresent = true;
  try {
    updateExePresent = exists(path.win32.join(root, 'Update.exe'));
  } catch {
    updateExePresent = true;
  }
  if (!updateExePresent) missing.push('Update.exe');
  return missing.length > 0 ? { root, missing } : null;
}

/**
 * Boot-time wiring: warn once, loudly, when the installation is incomplete.
 *
 * English on purpose — this is an installer-corruption diagnostic, shown at
 * most once per boot on a machine whose install is already broken; routing
 * it through the locale system would add 23 files of surface (and the pl
 * parity gate) for a message whose audience is "someone about to reinstall".
 * `dialog.showErrorBox` follows the existing precedent for boot-path fatal
 * notices in index.ts. Best-effort by contract: a failure to warn must never
 * affect boot.
 */
export function warnOnInstallIntegrityGap(): void {
  if (process.platform !== 'win32') return;
  let gap: InstallIntegrityGap | null = null;
  try {
    gap = findInstallIntegrityGap(process.execPath);
  } catch {
    return;
  }
  if (!gap) return;
  console.warn(
    `[install-integrity] incomplete installation at ${gap.root}: missing ${gap.missing.join(', ')} — ` +
    'in-app updates and uninstall will fail until wmux is reinstalled (#1046)',
  );
  try {
    // Lazy so importing this module never drags electron into a test process.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dialog } = require('electron') as typeof import('electron');
    dialog.showErrorBox(
      'wmux — incomplete installation',
      `This wmux installation is missing ${gap.missing.join(', ')} — the last install did not finish ` +
      '(an antivirus scan interrupting the installer can cause this).\n\n' +
      'wmux itself runs, but in-app updates and uninstalling will fail until it is reinstalled. ' +
      'Download the latest installer from github.com/openwong2kim/wmux/releases and run it to repair.',
    );
  } catch { /* best-effort — never block boot over a warning */ }
}
