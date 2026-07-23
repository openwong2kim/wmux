import type { CustomKeybinding } from '../../shared/types';

// === Detect "bare" F-keys (F1–F12) in custom keybindings (pure helper) ===
//
// With macOS default settings (`com.apple.keyboard.fnState` = 0), F1–F12 act as media/
// system keys and keydown events never reach the app. Bare F-key bindings without
// modifiers (e.g. 'F7') therefore do not fire unless Fn is held or system settings
// change. Modifier combos ('Ctrl+F7', etc.) can still be intercepted by macOS system
// shortcuts (^F7, etc.), so the Mac default is 'Ctrl+7', not an F-key. Guidance text
// applies only to bare F-key bindings — it must not appear on modified combos
// (self-contradictory).
//
// Pure function: callable from render/selectors without a store; easy to unit test.

/** Returns whether the string matches F1–F12 (excludes F13+). */
const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/;

/**
 * Whether a combo string is a bare F-key (F1–F12) without modifiers.
 * e.g. 'F7' → true, 'Ctrl+F7' → false ('+' prevents regex match), 'A' → false.
 */
export function isBareFunctionKeyCombo(key: string): boolean {
  return FUNCTION_KEY_RE.test(key.trim());
}

/**
 * True when any custom keybinding uses a bare F-key without modifiers.
 * (Used as the macOS-only guidance visibility condition.)
 */
export function hasBareFunctionKeyBinding(keybindings: CustomKeybinding[]): boolean {
  return keybindings.some((kb) => isBareFunctionKeyCombo(kb.key));
}
