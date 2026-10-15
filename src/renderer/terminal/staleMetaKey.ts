// Recovery for #1950: a printable key that arrives on Windows carrying a Meta
// (Win key) flag the user is not holding.
//
// Chromium on Windows reads the modifier flags of a KeyboardEvent from the
// renderer thread's key state. When that state keeps a Meta that was already
// released (its keyup landed somewhere else), every later keystroke carries
// `metaKey`, and xterm encodes no byte for a Meta chord on Windows: Space and
// plain letters then reach the focused terminal and produce nothing, in every
// pane, until the app restarts. That is the one modifier state that matches
// the #1950 report; how the flag goes stale in the field is not established.
//
// When the window has not seen the Win key's own keydown since it last gained
// focus (modifierPressTracker), the flag is not trusted and the key's text is
// written as the plain character xterm would have sent without it. A Win key
// that is really held keeps its chord, so this never changes a real Win+key.
//
// Known false positive: the Win key pressed while this window had no focus
// (or inside the in-app browser), then still held while a character is typed
// in a terminal. That character is typed. Windows takes most bound Win chords
// itself before the app sees them, so this is rare.

import type { ModifierName } from './modifierPressTracker';

export interface StaleMetaKeyEvent {
  key: string;
  keyCode: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

export interface StaleMetaKeyContext {
  /** The OS of the window drawing the terminal (`window.electronAPI.platform`). */
  platform: string | undefined;
  /** The modifiers this keydown carries with no press of them seen. */
  staleMods: readonly ModifierName[];
  /** xterm's own encoder takes this key (a kitty-negotiated pane). */
  xtermEncodes: boolean;
}

/**
 * The text to write for a printable key whose only modifier besides Shift is
 * a stale Meta on Windows, or null when xterm should handle the key as usual.
 * Shift is already folded into `key`. Pure.
 */
export function resolveStaleMetaText(e: StaleMetaKeyEvent, ctx: StaleMetaKeyContext): string | null {
  if (ctx.platform !== 'win32') return null;
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  if (!ctx.staleMods.includes('Meta')) return null;
  // An IME owns the key (its preedit, or the 229 "Process" keydown).
  if (e.isComposing || e.keyCode === 229) return null;
  // A kitty-negotiated pane gets the key from xterm's encoder; xterm sends a
  // super chord there, which is not silent.
  if (ctx.xtermEncodes) return null;
  // One printable character: not a named key (Enter, Tab, Dead, Process…).
  const chars = [...e.key];
  if (chars.length !== 1) return null;
  const cp = chars[0].codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return null;
  return e.key;
}

/**
 * One `[wmux:stale-meta]` line per focus session, so a recovered keystroke
 * still leaves the field evidence the dead-input watchdog used to give.
 * `session` is the focus session the key arrived in (it changes on blur).
 */
export function createStaleMetaNotice(): { shouldLog(session: number): boolean } {
  let logged: number | null = null;
  return {
    shouldLog(session) {
      if (logged === session) return false;
      logged = session;
      return true;
    },
  };
}
