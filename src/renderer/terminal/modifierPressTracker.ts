// Diagnostic for #1950: is a keydown carrying a modifier flag the user is not
// actually holding?
//
// Chromium on Windows derives KeyboardEvent.ctrlKey/altKey/shiftKey/metaKey
// from the renderer thread's key state, not from the key being pressed. If
// that state goes stale (a modifier keyup delivered somewhere else), every
// later keystroke carries the flag. A stale Meta is the one state that would
// make Space and bare letters produce nothing at all: xterm encodes no byte
// for a Meta chord on Windows (its keydown has no `result.key`, its keypress
// returns early on `metaKey`), so the watchdog sees "keys reached the
// textarea, no onData", in every pane at once.
//
// A modifier flag is only trusted when this window has seen that modifier's
// own keydown since it last gained focus and not yet its keyup. A flag with no
// such press behind it is "stale". This module only answers the question;
// it never changes what a key does.

export type ModifierName = 'Ctrl' | 'Alt' | 'Shift' | 'Meta';

/** The modifier a key itself is, from its physical code, or null. */
export function modifierOfCode(code: string): ModifierName | null {
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight') return 'Meta';
  return null;
}

export interface ModifierFlags {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The modifier flags a keydown carries, in a fixed order. */
export function modifiersOf(e: ModifierFlags): ModifierName[] {
  const out: ModifierName[] = [];
  if (e.ctrlKey) out.push('Ctrl');
  if (e.altKey) out.push('Alt');
  if (e.shiftKey) out.push('Shift');
  if (e.metaKey) out.push('Meta');
  return out;
}

/** `Ctrl+Shift`, or `none` when the key carries no modifier. */
export function formatModifiers(mods: readonly ModifierName[]): string {
  return mods.length === 0 ? 'none' : mods.join('+');
}

export interface ModifierPressTracker {
  /** Any keydown in the window (capture phase, before the terminal sees it). */
  onKeyDown(e: { code: string }): void;
  /** Any keyup in the window. */
  onKeyUp(e: { code: string }): void;
  /** The window lost focus: a keyup may now land elsewhere, so forget presses. */
  onBlur(): void;
  /** Modifiers whose flag `e` carries with no press of that modifier seen. */
  staleModifiers(e: ModifierFlags): ModifierName[];
}

export function createModifierPressTracker(): ModifierPressTracker {
  const held = new Set<ModifierName>();
  return {
    onKeyDown(e) {
      const mod = modifierOfCode(e.code);
      if (mod) held.add(mod);
    },
    onKeyUp(e) {
      const mod = modifierOfCode(e.code);
      if (mod) held.delete(mod);
    },
    onBlur() {
      held.clear();
    },
    staleModifiers(e) {
      return modifiersOf(e).filter((m) => !held.has(m));
    },
  };
}

let shared: ModifierPressTracker | null = null;

/**
 * The window's one tracker, installed on first use. Every terminal reads the
 * same window-level key state, so one set of listeners serves them all. The
 * listeners are capture-phase on `window`, so they run before any terminal's
 * textarea listener for the same keydown.
 */
export function sharedModifierPressTracker(): ModifierPressTracker {
  if (shared) return shared;
  const tracker = createModifierPressTracker();
  shared = tracker;
  if (typeof window !== 'undefined') {
    // A hot-reloaded copy of this module replaces the previous listeners
    // instead of stacking a second set.
    const KEY = '__wmuxModifierPressTracker';
    const w = window as unknown as Record<string, { dispose(): void } | undefined>;
    w[KEY]?.dispose();
    const down = (e: KeyboardEvent) => tracker.onKeyDown(e);
    const up = (e: KeyboardEvent) => tracker.onKeyUp(e);
    const blur = () => tracker.onBlur();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    w[KEY] = {
      dispose: () => {
        window.removeEventListener('keydown', down, true);
        window.removeEventListener('keyup', up, true);
        window.removeEventListener('blur', blur);
      },
    };
  }
  return tracker;
}
