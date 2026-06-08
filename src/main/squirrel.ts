/**
 * Squirrel.Windows installer-event classification.
 *
 * Squirrel relaunches the app with a CLI flag at each point in the install
 * lifecycle. Four of those are *installer hooks* — the app must do its
 * shortcut/registry work and exit immediately, before any BrowserWindow or
 * Chromium subprocess spins up:
 *
 *   --squirrel-install     first install
 *   --squirrel-updated     in-place update
 *   --squirrel-uninstall   removal
 *   --squirrel-obsolete    old version being superseded
 *
 * '--squirrel-firstrun' is deliberately NOT in this list. It is NOT an
 * installer hook — Squirrel passes it on the very first *normal* launch after
 * install (electron-squirrel-startup returns false for it, i.e. "keep running
 * normally"). It must fall through to the regular app init path so the
 * single-instance lock can dedupe it against the clean instance auto-launched
 * from the --squirrel-install handler. Misclassifying it as an installer event
 * leaves a main process that never quits and never inits — an invisible zombie
 * that lazily spawns its own gpu-process and network utility, contending with
 * the real window (the bug this module exists to prevent).
 *
 * Pure + side-effect-free so it can be unit-tested directly; index.ts cannot be
 * imported in tests because it runs appInit() at module load.
 */
export const SQUIRREL_INSTALLER_EVENTS = [
  '--squirrel-install',
  '--squirrel-updated',
  '--squirrel-uninstall',
  '--squirrel-obsolete',
] as const;

/**
 * True only for the four installer lifecycle events that must handle-and-exit.
 * Everything else — '--squirrel-firstrun', unknown '--squirrel-*' args, a normal
 * launch with no flag, dev's exe path — returns false and runs the app normally.
 */
export function isSquirrelInstallerEvent(argv1: string | undefined): boolean {
  return argv1 !== undefined
    && (SQUIRREL_INSTALLER_EVENTS as readonly string[]).includes(argv1);
}
