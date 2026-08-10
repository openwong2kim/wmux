import { describe, it, expect } from 'vitest';
import {
  WMUX_KEYMAP,
  builtinCombosFor,
  collidesWithKeymap,
  ADVERTISED_SHORTCUTS,
} from '../keymap';

/**
 * The table only earns its keep if its rows are in the SAME spelling the
 * Settings conflict check compares against — an exact Set lookup on whatever
 * `formatKeyCombo()` persisted. Every case here is a way the two can drift
 * apart while every existing test still passes (Codex review on #854).
 */

/** The renderer's `formatKeyCombo` (useKeyboard.ts), duplicated to pin the shape. */
function formatKeyCombo(ctrl: boolean, shift: boolean, alt: boolean, key: string): string {
  const parts: string[] = [];
  if (ctrl) parts.push('Ctrl');
  if (shift) parts.push('Shift');
  if (alt) parts.push('Alt');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

describe('storage form', () => {
  it('spells directional keys the way KeyboardEvent.key does', () => {
    // e.key is 'ArrowUp', never 'Up'. A row written as 'Ctrl+Shift+Up' can
    // never match what the capture overlay persisted.
    const combos = builtinCombosFor('win32');
    expect(combos.has(formatKeyCombo(true, true, false, 'ArrowUp'))).toBe(true);
    expect(combos.has(formatKeyCombo(true, false, true, 'ArrowRight'))).toBe(true);
    expect(combos.has(formatKeyCombo(false, false, true, 'ArrowDown'))).toBe(true);
  });

  it('covers the zoom aliases the handler accepts without requiring !shift', () => {
    // zoomIn takes '=', '+', Equal and NumpadAdd; zoomOut takes '-', '_',
    // Minus and NumpadSubtract. None of them check shift, so the shifted
    // spellings reach zoom too and a custom binding on them never fires.
    const combos = builtinCombosFor('win32');
    for (const key of ['=', '+']) {
      expect(combos.has(formatKeyCombo(true, false, false, key))).toBe(true);
      expect(combos.has(formatKeyCombo(true, true, false, key))).toBe(true);
    }
    for (const key of ['-', '_']) {
      expect(combos.has(formatKeyCombo(true, false, false, key))).toBe(true);
      expect(combos.has(formatKeyCombo(true, true, false, key))).toBe(true);
    }
  });

  it('leaves reset zoom unshifted, matching its !shift guard', () => {
    expect(builtinCombosFor('win32').has('Ctrl+0')).toBe(true);
    expect(builtinCombosFor('win32').has('Ctrl+Shift+0')).toBe(false);
  });

  it('writes every row in formatKeyCombo modifier order', () => {
    for (const { combo } of WMUX_KEYMAP) {
      // The key half can itself be '+', so the separator is the LAST '+'
      // that is not the key — 'Ctrl++' is Ctrl plus the '+' key.
      const key = combo.endsWith('+') ? '+' : combo.slice(combo.lastIndexOf('+') + 1);
      const modStr = combo.slice(0, combo.length - key.length).replace(/\+$/, '');
      const mods = modStr ? modStr.split('+') : [];
      expect(mods).toEqual(['Ctrl', 'Shift', 'Alt'].filter((m) => mods.includes(m)));
    }
  });
});

describe('builtinCombosFor', () => {
  it('drops the cmdOrCtrl family on macOS', () => {
    // A custom binding is matched on literal Ctrl everywhere, but these
    // built-ins fire on ⌘ under macOS — so they cannot collide there.
    const mac = builtinCombosFor('darwin');
    expect(mac.has('Ctrl+D')).toBe(false);
    expect(mac.has('Ctrl+Shift+A')).toBe(false);
    expect(builtinCombosFor('win32').has('Ctrl+D')).toBe(true);
  });

  it('keeps the literal-Ctrl family and the Ctrl-less rows on macOS', () => {
    const mac = builtinCombosFor('darwin');
    expect(mac.has('Ctrl+M')).toBe(true);        // bookmark — literal Ctrl on mac
    expect(mac.has('Ctrl+B')).toBe(true);        // tmux prefix
    expect(mac.has('Alt+ArrowUp')).toBe(true);   // no Ctrl at all
  });
});

describe('accelerator side is unaffected by the storage spelling', () => {
  it('still catches a menu accelerator naming a directional chord', () => {
    // Electron spells these 'Up'; the table now says 'ArrowUp'.
    // normalizeAcceleratorKey folds them together, so the menu guard holds.
    expect(collidesWithKeymap('Control+Shift+Up', 'win32')).toBe(true);
    expect(collidesWithKeymap('Alt+Up', 'win32')).toBe(true);
  });

  it('still catches the zoom roles', () => {
    expect(collidesWithKeymap('CommandOrControl+0', 'win32')).toBe(true);
    expect(collidesWithKeymap('CommandOrControl+Plus', 'win32')).toBe(true);
    expect(collidesWithKeymap('CommandOrControl+-', 'win32')).toBe(true);
  });
});

describe('ADVERTISED_SHORTCUTS', () => {
  it('lists only rows carrying an i18n key, in table order', () => {
    const expected = WMUX_KEYMAP.filter((e) => e.descriptionKey !== null).map((e) => e.combo);
    expect(ADVERTISED_SHORTCUTS.map((e) => e.combo)).toEqual(expected);
  });
});
