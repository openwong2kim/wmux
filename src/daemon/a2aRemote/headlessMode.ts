import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether this daemon starts and feeds remote-spawned agents itself (headless
 * mode): only on an install the desktop app has never used, and only once the
 * owner of the box opted in with `wmux daemon headless on`.
 *
 * The opt-in is a flag file in the a2a dir, written and removed by the CLI.
 * It is read on every question, so `off` stops new starts at once. The app's
 * signals turn headless mode off for good: at boot, its launcher started this
 * daemon or it attached here before (appHostMarker.ts); in this run, `appSeen`
 * (its identify recorded the attach, or it published its panes). The app then
 * owns delivery, and no headless start stays.
 */

export const HEADLESS_FLAG_FILE = 'headless-worker';

export function headlessFlagPath(a2aDir: string): string {
  return path.join(a2aDir, HEADLESS_FLAG_FILE);
}

export interface HeadlessModeDeps {
  a2aDir: string;
  /** The app is known to use this install already (applyAppHostAtBoot's answer). */
  appHostAtBoot: boolean;
  /** The app showed up in this run; asked on every `active()`, and sticky once true. */
  appSeen?: () => boolean;
  exists?: (p: string) => boolean;
}

export class HeadlessMode {
  private readonly flag: string;
  private readonly exists: (p: string) => boolean;
  private readonly appSeen: () => boolean;
  private appAttached: boolean;
  private readonly listeners: Array<() => void> = [];

  constructor(deps: HeadlessModeDeps) {
    this.flag = headlessFlagPath(deps.a2aDir);
    this.exists = deps.exists ?? fs.existsSync;
    this.appSeen = deps.appSeen ?? ((): boolean => false);
    this.appAttached = deps.appHostAtBoot;
  }

  /** The owner opted in (the flag file is there). */
  optedIn(): boolean {
    try {
      return this.exists(this.flag);
    } catch {
      return false;
    }
  }

  active(): boolean {
    if (!this.appAttached) {
      let seen = false;
      try {
        seen = this.appSeen();
      } catch {
        // Unknown counts as not seen; asked again next time.
      }
      if (seen) this.markAppAttached();
    }
    return !this.appAttached && this.optedIn();
  }

  /** The app showed up on this daemon: headless mode is off from now on. */
  markAppAttached(): void {
    if (this.appAttached) return;
    this.appAttached = true;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // A listener's failure must not keep the others from running.
      }
    }
  }

  onAppAttached(fn: () => void): void {
    this.listeners.push(fn);
  }
}
