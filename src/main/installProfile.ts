/**
 * Is the Squirrel install hook installing onto a profile that already uses
 * wmux, or is this a first install?
 *
 * Every in-app update on Windows is a Squirrel FULL install: Setup.exe wipes
 * the install root and installs from scratch, so the new app runs
 * `--squirrel-install`, never `--squirrel-updated` (Squirrel's log says
 * "First run, starting from scratch"). The install hook used to treat every
 * run as a first install: it turned autostart on and created the Desktop
 * shortcut, so a user who had turned autostart off or deleted the shortcut
 * got both back on every update.
 *
 * The install root cannot answer the question (it was just wiped), but
 * userData can: Setup.exe never touches it. A normal boot writes a marker
 * there, and the hook reads it.
 *
 * The decision is pure (`planInstallHook`); the marker helpers are thin and
 * never throw into the hook or the boot.
 */
import * as fs from 'fs';
import * as path from 'path';

/** In userData. Content is a state word, see ProfileMarkerState. */
export const PROFILE_MARKER_FILE = 'install-profile';

/**
 * 'active': wmux has started normally on this profile.
 * 'uninstalled': the uninstall hook ran since. A later install is a first
 *   install again (the uninstall removed autostart and the shortcuts).
 */
type ProfileMarkerState = 'active' | 'uninstalled';

/**
 * The userData directory as the app will resolve it, computed in the install
 * hook. The hook runs at the top of index.ts, before appInit applies
 * WMUX_DATA_SUFFIX with app.setPath('userData', base + suffix), so it adds the
 * suffix itself. An installed copy runs without one, which makes this the
 * unsuffixed `%APPDATA%\wmux` in practice.
 */
export function hookUserDataDir(baseUserData: string, env: NodeJS.ProcessEnv): string {
  return baseUserData + (env.WMUX_DATA_SUFFIX || '');
}

function readMarker(userDataDir: string): ProfileMarkerState | null {
  try {
    const value = fs.readFileSync(path.join(userDataDir, PROFILE_MARKER_FILE), 'utf-8').trim();
    return value === 'active' || value === 'uninstalled' ? value : null;
  } catch {
    return null;
  }
}

function writeMarker(userDataDir: string, state: ProfileMarkerState): void {
  try {
    if (readMarker(userDataDir) === state) return;
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, PROFILE_MARKER_FILE), state, 'utf-8');
  } catch (err) {
    console.warn(`[installProfile] could not write the profile marker (${state}):`, err);
  }
}

/** Every normal startup. */
export function markProfileActive(userDataDir: string): void {
  writeMarker(userDataDir, 'active');
}

/** The uninstall hook. */
export function markProfileUninstalled(userDataDir: string): void {
  writeMarker(userDataDir, 'uninstalled');
}

/**
 * True when wmux has already been used on this profile (and not uninstalled
 * since).
 *
 * Versions before the marker never wrote it, so the first update from one of
 * them finds no marker. For that case the answer is `session.json` in the
 * same userData: the session store every wmux version has written there on
 * its first normal run and kept since (SessionManager), and the file
 * postInstallReconcile already reads as "this profile has been used". Setup.exe
 * does not touch userData, so it is still there when the hook runs.
 */
export function isExistingProfile(userDataDir: string): boolean {
  const marker = readMarker(userDataDir);
  if (marker !== null) return marker === 'active';
  return fs.existsSync(path.join(userDataDir, 'session.json'));
}

export interface InstallHookPlan {
  /** 'enable' turns autostart on; 'refresh' only repoints it if it is already on. */
  autostart: 'enable' | 'refresh';
  /** Value for Update.exe's `--shortcut-locations`; null runs no --createShortcut. */
  shortcutLocations: 'Desktop' | null;
}

/**
 * First install: autostart on, and a Desktop shortcut.
 * Existing profile (an update): leave autostart as the user set it, only
 * repointing it at the new exe; no Desktop shortcut, so one the user deleted
 * stays deleted.
 *
 * Update.exe never writes the Start Menu entry. Electron's toast setup owns
 * `Programs\wmux.lnk` (it rewrites that one path to match the running app),
 * while Squirrel's would go to `Programs\<publisher>\wmux.lnk`, so asking for
 * both leaves two "wmux" entries (#2971). The app writes its entry at startup
 * instead (notification/startMenuEntry.ts).
 */
export function planInstallHook(existingProfile: boolean): InstallHookPlan {
  return existingProfile
    ? { autostart: 'refresh', shortcutLocations: null }
    : { autostart: 'enable', shortcutLocations: 'Desktop' };
}
