// Windows that are not the app window (today: the quick-launch composer).
// App-level code that means "the wmux window" — Dock activation, toast clicks
// and taskbar flashes, focus/presence checks, file-watch events — must not
// land on one of these, and BrowserWindow.getAllWindows() order is not a
// guarantee of which window comes first.

import { BrowserWindow } from 'electron';

const auxiliary = new WeakSet<BrowserWindow>();

export function markAuxiliaryWindow(win: BrowserWindow): void {
  auxiliary.add(win);
}

export function isAuxiliaryWindow(win: BrowserWindow | null | undefined): boolean {
  return Boolean(win && auxiliary.has(win));
}

/** The first live window that is not auxiliary. */
export function primaryWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !auxiliary.has(w) && !w.isDestroyed());
}

/** The focused window when it is the app window, else null. */
export function focusedPrimaryWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !auxiliary.has(focused) ? focused : null;
}
