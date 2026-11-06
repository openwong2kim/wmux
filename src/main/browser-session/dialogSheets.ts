// Closing the box a page dialog leaves behind once someone has answered it.
//
// Answering a dialog over CDP doesn't close Electron's native box. On macOS the
// box is a sheet on the tab's window, and a sheet takes the window's keyboard and
// mouse until someone clicks it. So when a dialog closes, whoever answered it
// (main, an attached Playwright page, the person), its sheet is ended too.
//
// Which sheet belongs to which dialog is decided when the dialog opens: the oldest
// sheet on the tab's window that no dialog has claimed yet and whose text is
// exactly the dialog's message. The text check matters: wmux's own message boxes
// are sheets on the same window, and ending one would answer a question asked of
// the person. Openings claim in the order they arrived, per window, so two tabs
// showing the same message can't swap sheets: ending the other one would answer a
// person's live dialog. After that, only the sheet's identity counts. At close it
// is ended only if that same sheet is still showing.
//
// Anything that goes wrong here costs the box closing, never the dialog's answer:
// one warning, and every box stays as it did before.

import type { BrowserWindow, WebContents } from 'electron';
import { createObjcSheetPort, hostWindowOf, loadObjc } from './dialogSheets.darwin';

/** What GuestDialogs needs. Every call is safe to make on any platform. */
export interface DialogSheets {
  /** `Page.javascriptDialogOpening` on this surface's guest. */
  trackOpening(surfaceId: string, guest: WebContents | undefined, message: string): void;
  /** `Page.javascriptDialogClosed`: end this surface's sheet if it is still showing. */
  closeIfStale(surfaceId: string): void;
  /** The surface is gone; let go of anything tracked for it. */
  forget(surfaceId: string): void;
}

export const NO_DIALOG_SHEETS: DialogSheets = {
  trackOpening: () => undefined,
  closeIfStale: () => undefined,
  forget: () => undefined,
};

/** Native access to a window's sheets. `S` is an opaque sheet handle. */
export interface SheetPort<H, S> {
  /** The window's sheets, in queue order (the one showing first). */
  list(host: H): S[];
  texts(sheet: S): string[];
  same(a: S, b: S): boolean;
  retain(sheet: S): void;
  release(sheet: S): void;
  /** End the sheet from the run loop, never inside this call. */
  endLater(host: H, sheet: S): void;
}

export interface SheetTrackerDeps<H, S> {
  /** Resolved on first use. Throwing disables the tracker. */
  port: () => SheetPort<H, S>;
  schedule: (fn: () => void, ms: number) => void;
  warn: (message: string) => void;
}

export interface SheetTracker<H> {
  trackOpening(surfaceId: string, host: H, message: string): void;
  closeIfStale(surfaceId: string): void;
  forget(surfaceId: string): void;
  forgetHost(host: H): void;
}

/** How long an opening keeps looking for its sheet, which can appear a moment later. */
export const SHEET_RETRY_MS = 60;
export const SHEET_RETRIES = 6;

interface Pending<H> {
  surfaceId: string;
  host: H;
  message: string;
  tries: number;
  /** Closed before its sheet was found: end the sheet as soon as it is. */
  closed: boolean;
}

interface Tracked<H, S> {
  host: H;
  sheet: S;
}

export function createSheetTracker<H extends object, S>(deps: SheetTrackerDeps<H, S>): SheetTracker<H> {
  let port: SheetPort<H, S> | null = null;
  let disabled = false;
  const tracked = new Map<string, Tracked<H, S>>();
  const pending: Pending<H>[] = [];

  /** Run `fn` against the port; any failure warns once and turns the tracker off. */
  const guard = <T>(fn: (p: SheetPort<H, S>) => T): T | undefined => {
    if (disabled) return undefined;
    try {
      port ??= deps.port();
      return fn(port);
    } catch (err) {
      disabled = true;
      deps.warn(`[dialog-sheets] off for this run, answered boxes stay open: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const release = (entry: Tracked<H, S>): void => {
    guard((p) => p.release(entry.sheet));
  };

  const endIfShowing = (entry: Tracked<H, S>): void => {
    guard((p) => {
      if (p.list(entry.host).some((sheet) => p.same(sheet, entry.sheet))) p.endLater(entry.host, entry.sheet);
    });
  };

  const scheduled = new Set<H>();

  /**
   * Pair this window's waiting openings with its unclaimed sheets, in the order
   * the openings arrived: the oldest opening with a message gets the oldest free
   * sheet with that text. A later opening never takes a sheet an earlier one with
   * the same text is still waiting for.
   */
  const scanHost = (host: H, retry: boolean): void => {
    guard((p) => {
      const waiting = pending.filter((o) => o.host === host);
      if (waiting.length === 0) return;
      const claimed = [...tracked.values()].filter((t) => t.host === host).map((t) => t.sheet);
      const free = p.list(host).filter((s) => !claimed.some((c) => p.same(c, s)));
      for (const opening of waiting) {
        const index = free.findIndex((s) => p.texts(s).some((text) => text === opening.message));
        if (index < 0) {
          if (retry) opening.tries += 1;
          if (opening.tries > SHEET_RETRIES) pending.splice(pending.indexOf(opening), 1);
          continue;
        }
        const [sheet] = free.splice(index, 1);
        pending.splice(pending.indexOf(opening), 1);
        p.retain(sheet);
        const entry = { host, sheet };
        if (opening.closed) {
          endIfShowing(entry);
          release(entry);
        } else {
          tracked.set(opening.surfaceId, entry);
        }
      }
      if (pending.some((o) => o.host === host) && !scheduled.has(host)) {
        scheduled.add(host);
        deps.schedule(() => {
          scheduled.delete(host);
          scanHost(host, true);
        }, SHEET_RETRY_MS);
      }
    });
  };

  const drop = (surfaceId: string): void => {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].surfaceId === surfaceId) pending.splice(i, 1);
    const entry = tracked.get(surfaceId);
    if (entry) {
      tracked.delete(surfaceId);
      release(entry);
    }
  };

  return {
    trackOpening(surfaceId, host, message) {
      if (disabled || message === '') return;
      // A page shows one dialog at a time, so anything still held is from before.
      drop(surfaceId);
      const opening: Pending<H> = { surfaceId, host, message, tries: 0, closed: false };
      pending.push(opening);
      scanHost(host, false);
    },
    closeIfStale(surfaceId) {
      const waiting = pending.find((p) => p.surfaceId === surfaceId);
      if (waiting) {
        waiting.closed = true;
        return;
      }
      const entry = tracked.get(surfaceId);
      if (!entry) return;
      tracked.delete(surfaceId);
      endIfShowing(entry);
      release(entry);
    },
    forget(surfaceId) {
      drop(surfaceId);
    },
    forgetHost(host) {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].host === host) pending.splice(i, 1);
      for (const [surfaceId, entry] of [...tracked]) {
        if (entry.host !== host) continue;
        tracked.delete(surfaceId);
        release(entry);
      }
    },
  };
}

/**
 * The real thing on macOS; nothing elsewhere, or with WMUX_DIALOG_SHEET_CLOSE=0
 * (read once). koffi loads on the first dialog, not at startup.
 */
export function createDialogSheets(): DialogSheets {
  if (process.platform !== 'darwin' || process.env['WMUX_DIALOG_SHEET_CLOSE'] === '0') return NO_DIALOG_SHEETS;
  const tracker = createSheetTracker<BrowserWindow, unknown>({
    port: () => {
      const port = createObjcSheetPort(loadObjc());
      console.log('[dialog-sheets] macOS: an answered dialog\'s box closes');
      return port;
    },
    schedule: (fn, ms) => { setTimeout(fn, ms).unref?.(); },
    warn: (message) => console.warn(message),
  });
  const watched = new WeakSet<BrowserWindow>();
  return {
    trackOpening(surfaceId, guest, message) {
      let host: BrowserWindow | null = null;
      try {
        host = guest && !guest.isDestroyed() ? hostWindowOf(guest) : null;
      } catch {
        host = null;
      }
      if (!host) return;
      if (!watched.has(host)) {
        watched.add(host);
        const closing = host;
        closing.once('closed', () => tracker.forgetHost(closing));
      }
      tracker.trackOpening(surfaceId, host, message);
    },
    closeIfStale: (surfaceId) => tracker.closeIfStale(surfaceId),
    forget: (surfaceId) => tracker.forget(surfaceId),
  };
}
