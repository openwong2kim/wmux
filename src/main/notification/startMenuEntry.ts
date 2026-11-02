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
//
// Installs before #2971 also have Squirrel's `Programs\<publisher>\wmux.lnk`.
// Once the top-level entry exists, that one is removed (shortcutHygiene.ts
// removeSecondStartMenuEntry), so an update never leaves the app without an
// entry while it moves from one to the other.

import * as fs from 'fs';
import * as path from 'path';
import { Notification } from 'electron';
import { removeSecondStartMenuEntry } from '../shortcutHygiene';

/** How long after startup the second entry is looked for: Electron writes the
 *  top-level one on a background task, and nothing here is urgent. */
const SECOND_ENTRY_DELAY_MS = 20_000;

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

/**
 * The author name in the app's package.json: the packager makes it the exe's
 * CompanyName, which Squirrel names its Start Menu folder after. Empty when it
 * cannot be read.
 */
export function publisherFromPackageJson(appPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8')) as { author?: unknown };
    const author = pkg.author;
    if (typeof author === 'string') return author.replace(/\s*[<(].*$/, '').trim();
    if (author && typeof author === 'object' && typeof (author as { name?: unknown }).name === 'string') {
      return (author as { name: string }).name.trim();
    }
  } catch { /* unreadable: no publisher */ }
  return '';
}

/**
 * Write the entry now, and later remove Squirrel's second one from installs
 * before #2971. Never throws.
 */
export function keepOneStartMenuEntry(execPath: string, appPath: string): void {
  writeStartMenuEntry();
  const publisher = publisherFromPackageJson(appPath);
  if (!publisher) return;
  setTimeout(() => {
    void removeSecondStartMenuEntry(execPath, publisher).then((r) => {
      for (const a of r.actions) console.log(`[startMenu] ${a.action} the second Start Menu entry ${a.path}`);
    });
  }, SECOND_ENTRY_DELAY_MS).unref();
}
