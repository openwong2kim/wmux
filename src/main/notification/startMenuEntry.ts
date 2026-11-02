// The installed app's one Start Menu entry, written at startup (#2971).
//
// On Windows, Electron's toast setup (Electron 42,
// shell/browser/notifications/win/windows_toast_activator.cc, EnsureShortcut)
// owns `%APPDATA%\Microsoft\Windows\Start Menu\Programs\<ProductName>.lnk`, the
// top level of Programs. It is the only link Electron reads or writes, and it
// rewrites it whenever its target, working directory, AppUserModelID or toast
// activator CLSID differs from the running app. It runs the first time the app
// asks for its notification presenter, and `Notification.isSupported()` is
// enough to ask.
//
// Squirrel's own Start Menu link would live in `Programs\<publisher>\`, a path
// Electron never looks at, so with both the user sees two "wmux" entries. The
// install hook therefore asks Update.exe for no Start Menu link
// (installProfile.ts), and the installed app runs Electron's setup at startup
// so its entry is there from the first launch rather than from the first toast.
//
// Only the installed app does this. A portable, test or isolated copy (a data
// suffix) would point the installed app's entry at itself (#2964).

import { Notification } from 'electron';

export interface StartMenuEntryProbe {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** WMUX_DATA_SUFFIX: non-empty for any isolated copy. */
  dataSuffix: string;
  /** The Squirrel install root of the running exe, or null when it is not one. */
  squirrelRoot: string | null;
}

/** Whether this process should write the Start Menu entry. Pure. */
export function shouldWriteStartMenuEntry(p: StartMenuEntryProbe): boolean {
  return p.platform === 'win32' && p.isPackaged && p.dataSuffix === '' && p.squirrelRoot !== null;
}

/**
 * Runs Electron's toast setup, which writes or repairs the Start Menu entry
 * and its toast activator registration off the UI thread. Never throws.
 */
export function writeStartMenuEntry(): void {
  try {
    Notification.isSupported();
  } catch (err) {
    console.warn('[startMenu] toast setup failed (non-fatal):', err);
  }
}
