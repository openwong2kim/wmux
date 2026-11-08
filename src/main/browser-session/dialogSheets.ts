// Closing the box a page dialog leaves behind once someone has answered it.
//
// Answering a dialog over CDP doesn't close Electron's native box. On macOS the
// box is a sheet on the tab's window, and a sheet takes the window's keyboard and
// mouse until someone clicks it. So when a dialog closes, whoever answered it
// (main, an attached Playwright page, the person), its sheet is ended too.
//
// Ending the wrong sheet answers someone else's question: a person's own dialog on
// another tab, or one of wmux's boxes, whose text a page can copy. So a dialog
// claims a sheet only when nothing else could be meant:
// - the sheet is new: this is the first look at the window that sees it. A sheet
//   seen before and left unclaimed never pairs later.
// - its shape is a page dialog's: exactly the message, no detail, and the buttons
//   of that dialog type.
// - no other tab is opening a dialog with the same text and type on the window,
//   and there are no more such new sheets than this tab's openings waiting for one.
// Anything else tracks nothing and the box stays as before: ambiguity costs a box,
// never a person's answer. At close only the sheet's identity counts, and it is
// ended only if that same sheet is still showing.
//
// Anything that goes wrong here costs the box closing, never the dialog's answer.

import type { BrowserWindow, WebContents } from 'electron';
import { createObjcSheetPort, hostWindowOf, loadObjc } from './dialogSheets.darwin';
import { createWin32BoxPort, loadWin32 } from './dialogSheets.win32';

/** What GuestDialogs needs. Every call is safe to make on any platform. */
export interface DialogSheets {
  /** `Page.javascriptDialogOpening` on this surface's guest. */
  trackOpening(surfaceId: string, guest: WebContents | undefined, message: string, type: string): void;
  /** `Page.javascriptDialogClosed`: end this surface's sheet if it is still showing. */
  closeIfStale(surfaceId: string): void;
  /** The surface is gone or its page crashed: end the sheet it owns. */
  forget(surfaceId: string): void;
}

export const NO_DIALOG_SHEETS: DialogSheets = {
  trackOpening: () => undefined,
  closeIfStale: () => undefined,
  forget: () => undefined,
};

/** What a sheet shows: its text fields in order (empty ones included) and its button titles. */
export interface SheetShape {
  texts: string[];
  buttons: string[];
}

/** Native access to a window's sheets. `S` is an opaque sheet handle. */
export interface SheetPort<H, S> {
  /** The window's sheets, in queue order (the one showing first). */
  list(host: H): S[];
  /** The sheet's identity: equal keys are the same sheet. */
  key(sheet: S): unknown;
  shape(sheet: S): SheetShape;
  retain(sheet: S): void;
  release(sheet: S): void;
  /** End the sheet from the run loop, never inside this call. */
  endLater(host: H, sheet: S): void;
}

export interface SheetTrackerDeps<H, S> {
  /** Resolved on first use. Throwing turns the tracker off for the run. */
  port: () => SheetPort<H, S>;
  schedule: (fn: () => void, ms: number) => void;
  now: () => number;
  /** Failures, and each dialog's pair or no-pair decision. */
  warn: (message: string) => void;
}

export interface SheetTracker<H> {
  trackOpening(surfaceId: string, host: H, message: string, type: string): void;
  closeIfStale(surfaceId: string): void;
  forget(surfaceId: string): void;
  forgetHost(host: H): void;
}

/** How long an opening keeps looking for its sheet, which can be listed a moment later. */
export const SHEET_RETRY_WINDOW_MS = 1_000;
const SHEET_RETRY_STEP_MS = 100;

/** Electron's buttons on a page's alert and confirm (English titles, sorted). */
const PAGE_DIALOG_BUTTONS: Readonly<Record<string, readonly string[]>> = {
  alert: ['OK'],
  confirm: ['Cancel', 'OK'],
};

interface Opening<H> {
  surfaceId: string;
  host: H;
  message: string;
  type: string;
  deadline: number;
  /** Closed before its sheet was found: end the sheet as soon as it is. */
  closed: boolean;
}

interface Owned<H, S> {
  host: H;
  sheet: S;
}

interface HostState {
  /** Keys of every sheet an earlier look saw, pruned to what is still listed. */
  known: Set<unknown>;
  /** Keys being ended, kept until they leave the list. */
  ending: Set<unknown>;
  retryScheduled: boolean;
}

/** A native step failed. It ends that call only; the next dialog tries again. */
class StepFailed extends Error {}

export function createSheetTracker<H extends object, S>(deps: SheetTrackerDeps<H, S>): SheetTracker<H> {
  let port: SheetPort<H, S> | null = null;
  let disabled = false;
  const hosts = new Map<H, HostState>();
  const owned = new Map<string, Owned<H, S>>();
  const openings: Opening<H>[] = [];

  const stateOf = (host: H): HostState => {
    let state = hosts.get(host);
    if (!state) {
      state = { known: new Set(), ending: new Set(), retryScheduled: false };
      hosts.set(host, state);
    }
    return state;
  };

  const loaded = (): SheetPort<H, S> | null => {
    if (disabled) return null;
    if (port) return port;
    try {
      port = deps.port();
      return port;
    } catch (err) {
      disabled = true;
      deps.warn(`[dialog-sheets] off for this run, answered boxes stay open: ${errorText(err)}`);
      return null;
    }
  };

  /** One native step. A failure is logged and aborts the rest of the call. */
  const step = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      deps.warn(`[dialog-sheets] ${what} failed: ${errorText(err)}`);
      throw new StepFailed(what);
    }
  };

  const decide = (opening: Opening<H>, decision: string): void => {
    deps.warn(`[dialog-sheets] ${opening.type} on ${opening.surfaceId}: ${decision}`);
  };

  const drop = (opening: Opening<H>): void => {
    const i = openings.indexOf(opening);
    if (i >= 0) openings.splice(i, 1);
  };

  /** End an owned sheet if it is still showing. What was retained is always released. */
  const end = (p: SheetPort<H, S>, entry: Owned<H, S>): void => {
    try {
      const key = p.key(entry.sheet);
      const state = stateOf(entry.host);
      if (state.ending.has(key)) return;
      if (!step('list', () => p.list(entry.host)).some((s) => p.key(s) === key)) return;
      state.ending.add(key);
      step('endLater', () => p.endLater(entry.host, entry.sheet));
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
    } finally {
      try {
        p.release(entry.sheet);
      } catch (err) {
        deps.warn(`[dialog-sheets] release failed: ${errorText(err)}`);
      }
    }
  };

  const looksLike = (shape: SheetShape, opening: Opening<H>): boolean => {
    const buttons = PAGE_DIALOG_BUTTONS[opening.type];
    if (!buttons) return false;
    const filled = shape.texts.filter((t) => t !== '');
    return filled.length === 1 && filled[0] === opening.message
      && [...shape.buttons].sort().join('\n') === buttons.join('\n');
  };

  /**
   * One look at the window. A sheet listed now that no earlier look saw is new,
   * and only a new sheet can pair; afterwards every listed sheet is known.
   */
  const look = (host: H): void => {
    const p = loaded();
    if (!p) return;
    const state = stateOf(host);
    try {
      const sheets = step('list', () => p.list(host));
      const keys = sheets.map((s) => p.key(s));
      const fresh = sheets.filter((_s, i) => !state.known.has(keys[i]) && !state.ending.has(keys[i]));
      state.known = new Set(keys);
      for (const key of [...state.ending]) if (!keys.includes(key)) state.ending.delete(key);

      const waiting = openings.filter((o) => o.host === host);
      if (waiting.length === 0) return;
      // Each new sheet's shape is read once per look.
      const shapes = fresh.map((s) => step('shape', () => p.shape(s)));
      // Openings that could match the same box: same text and type.
      const groups = new Map<string, Array<Opening<H>>>();
      for (const o of waiting) {
        const key = `${o.type}\n${o.message}`;
        groups.set(key, [...(groups.get(key) ?? []), o]);
      }
      for (const group of groups.values()) {
        // Two tabs showing the same text can't be told apart, and a mismatch would
        // end a person's box on the other tab. One tab's openings can: a page shows
        // its dialogs one after another, and their boxes queue in the same order, so
        // the oldest opening takes the earliest box. A mismatch there stays on that
        // tab: its next dialog's box closes a moment early, and it is being answered.
        if (new Set(group.map((o) => o.surfaceId)).size > 1) {
          for (const o of group) {
            decide(o, 'no pair: another tab is opening a dialog with the same text on this window');
            drop(o);
          }
          continue;
        }
        const candidates = fresh.filter((_s, i) => looksLike(shapes[i], group[0]));
        if (candidates.length > group.length) {
          for (const o of group) {
            decide(o, `no pair: ${candidates.length} new boxes look like it`);
            drop(o);
          }
          continue;
        }
        group.forEach((opening, i) => {
          const sheet = candidates[i];
          if (!sheet) {
            if (deps.now() >= opening.deadline) {
              decide(opening, 'no pair: no box like it was listed in time');
              drop(opening);
            }
            return;
          }
          step('retain', () => p.retain(sheet));
          drop(opening);
          decide(opening, 'paired');
          const entry = { host, sheet };
          if (opening.closed) end(p, entry);
          else owned.set(opening.surfaceId, entry);
        });
      }
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
    } finally {
      // A look that failed still lets its openings run out of time, or it retries for ever.
      for (const o of openings.filter((x) => x.host === host && deps.now() >= x.deadline)) {
        decide(o, 'no pair: the window could not be read in time');
        drop(o);
      }
      if (openings.some((o) => o.host === host) && !state.retryScheduled) {
        state.retryScheduled = true;
        deps.schedule(() => {
          // The window closed meanwhile (forgetHost): don't bring it back.
          if (hosts.get(host) !== state) return;
          state.retryScheduled = false;
          look(host);
        }, SHEET_RETRY_STEP_MS);
      }
    }
  };

  /** End and forget the sheet this surface owns. */
  const settle = (surfaceId: string): Owned<H, S> | undefined => {
    const entry = owned.get(surfaceId);
    if (!entry) return undefined;
    owned.delete(surfaceId);
    const p = loaded();
    if (p) end(p, entry);
    return entry;
  };

  return {
    trackOpening(surfaceId, host, text, type) {
      if (!loaded()) return;
      // A page shows one dialog at a time, so anything this surface still owns is
      // from before. An answered opening still looking for its sheet keeps looking.
      settle(surfaceId);
      for (const o of openings.filter((x) => x.surfaceId === surfaceId && !x.closed)) drop(o);
      const opening: Opening<H> = {
        surfaceId, host, message: text, type, deadline: deps.now() + SHEET_RETRY_WINDOW_MS, closed: false,
      };
      if (text === '' || !PAGE_DIALOG_BUTTONS[type]) decide(opening, 'no pair: not an alert or confirm with a message');
      else openings.push(opening);
      // Its box is new to the window either way; this look makes it known.
      look(host);
    },
    closeIfStale(surfaceId) {
      const waiting = openings.find((o) => o.surfaceId === surfaceId && !o.closed);
      if (waiting) {
        waiting.closed = true;
        look(waiting.host);
        return;
      }
      const entry = settle(surfaceId);
      if (entry) look(entry.host);
    },
    forget(surfaceId) {
      for (const o of openings.filter((x) => x.surfaceId === surfaceId)) drop(o);
      settle(surfaceId);
    },
    forgetHost(host) {
      for (const o of openings.filter((x) => x.host === host)) drop(o);
      const p = loaded();
      for (const [surfaceId, entry] of [...owned]) {
        if (entry.host !== host) continue;
        owned.delete(surfaceId);
        try {
          p?.release(entry.sheet);
        } catch (err) {
          deps.warn(`[dialog-sheets] release failed: ${errorText(err)}`);
        }
      }
      hosts.delete(host);
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The real thing on macOS (a window's sheets) and Windows (TaskDialog boxes,
 * dialogSheets.win32.ts); nothing elsewhere, or with
 * WMUX_DIALOG_SHEET_CLOSE=0 (read once). koffi loads on the first dialog,
 * not at startup.
 */
export function createDialogSheets(): DialogSheets {
  if (process.env['WMUX_DIALOG_SHEET_CLOSE'] === '0') return NO_DIALOG_SHEETS;
  if (process.platform === 'darwin') {
    return createHostedSheets(() => {
      const port = createObjcSheetPort(loadObjc());
      console.log('[dialog-sheets] macOS: an answered dialog\'s box closes');
      return port;
    });
  }
  if (process.platform === 'win32') {
    return createHostedSheets(() => {
      const port = createWin32BoxPort(loadWin32());
      console.log('[dialog-sheets] Windows: an answered dialog\'s box closes');
      return port;
    });
  }
  return NO_DIALOG_SHEETS;
}

/** A tracker on the tab's BrowserWindow, behind guards that keep every failure off the dialog's answer. */
function createHostedSheets<S>(port: () => SheetPort<BrowserWindow, S>): DialogSheets {
  // Every way into the tracker from outside goes through here, so whatever
  // throws behind it costs the box closing, never the dialog's answer.
  const guarded = <A extends unknown[]>(name: string, fn: (...args: A) => void) => (...args: A): void => {
    try {
      fn(...args);
    } catch (err) {
      console.warn(`[dialog-sheets] ${name} failed: ${errorText(err)}`);
    }
  };
  const tracker = createSheetTracker<BrowserWindow, S>({
    port,
    schedule: (fn, ms) => { setTimeout(guarded('retry', fn), ms).unref?.(); },
    now: () => Date.now(),
    warn: (text) => console.warn(text),
  });
  const watched = new WeakSet<BrowserWindow>();
  return {
    trackOpening: guarded('trackOpening', (surfaceId: string, guest: WebContents | undefined, text: string, type: string) => {
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
        closing.once('closed', guarded('forgetHost', () => tracker.forgetHost(closing)));
      }
      tracker.trackOpening(surfaceId, host, text, type);
    }),
    closeIfStale: guarded('closeIfStale', (surfaceId: string) => tracker.closeIfStale(surfaceId)),
    forget: guarded('forget', (surfaceId: string) => tracker.forget(surfaceId)),
  };
}
