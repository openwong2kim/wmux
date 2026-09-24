import { describe, it, expect } from 'vitest';
import {
  WMUX_KEYMAP,
  builtinCombosFor,
  collidesWithKeymap,
  ADVERTISED_SHORTCUTS,
  SHORTCUT_ACTION_IDS,
  comboFromEvent,
  concreteCombo,
  defaultBindings,
  displayCombo,
  effectiveBindings,
  invalidShortcutCombo,
  isPrefixTrigger,
  overridesFromDisabledCombos,
  rebindProblem,
  resolveShortcut,
  sanitizeShortcutOverrides,
  ShortcutPressGuard,
  type ShortcutKeyEventLike,
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
    expect(mac.has('Alt+ArrowUp')).toBe(true);   // no Ctrl at all
    // The ⌘ family is there in concrete form.
    expect(mac.has('Meta+D')).toBe(true);
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

  it('has exactly one row per action (the rest are aliases)', () => {
    const actions = ADVERTISED_SHORTCUTS.map((e) => e.action);
    expect(new Set(actions).size).toBe(actions.length);
    // Every action the table binds can be listed, changed and switched off.
    expect([...new Set(actions)].sort()).toEqual([...SHORTCUT_ACTION_IDS].sort());
  });

  it('puts an action\'s primary row before its aliases', () => {
    for (const row of ADVERTISED_SHORTCUTS) {
      expect(WMUX_KEYMAP.find((e) => e.action === row.action)).toBe(row);
    }
  });
});

// ─── #1455 one resolver ──────────────────────────────────────────────────────

const ev = (over: Partial<ShortcutKeyEventLike>): ShortcutKeyEventLike => ({
  key: 't', code: 'KeyT', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...over,
});
const win = defaultBindings('win32');
const mac = defaultBindings('darwin');

describe('resolveShortcut', () => {
  it('finds the action a default combo runs', () => {
    expect(resolveShortcut(ev({}), win)).toBe('newSurface');
    expect(resolveShortcut(ev({ key: 'D', code: 'KeyD', shiftKey: true }), win)).toBe('splitVertical');
    expect(resolveShortcut(ev({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: false, altKey: true }), win))
      .toBe('prevWorkspace');
  });

  it('matches modifiers exactly — no binding swallows a chord it does not name', () => {
    // The class of bug a per-branch if-chain kept producing: Alt+Up must not
    // also be Meta+Alt+Up, Ctrl+Alt+Up (pane focus) or Shift+Alt+Up.
    const up = ev({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: false, altKey: true });
    expect(resolveShortcut({ ...up, metaKey: true }, win)).toBeNull();
    expect(resolveShortcut({ ...up, shiftKey: true }, win)).toBeNull();
    expect(resolveShortcut({ ...up, ctrlKey: true }, win)).toBe('focusUpAlt');
    expect(resolveShortcut(ev({ altKey: true }), win)).toBeNull();
    expect(resolveShortcut(ev({ metaKey: true }), win)).toBeNull();
    expect(resolveShortcut(ev({ key: 'ArrowUp', code: 'ArrowUp' }), win)).toBeNull(); // bare Ctrl+Up
  });

  it('macOS: the ⌘ family fires on ⌘, and literal Ctrl stays the terminal\'s', () => {
    expect(resolveShortcut(ev({ ctrlKey: false, metaKey: true }), mac)).toBe('newSurface');
    expect(resolveShortcut(ev({}), mac)).toBeNull(); // Ctrl+T: a readline byte on mac
    expect(resolveShortcut(ev({ key: 'm', code: 'KeyM' }), mac)).toBe('addBookmark'); // literal Ctrl row
    expect(resolveShortcut(ev({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: false, metaKey: true, altKey: true }), mac))
      .toBe('focusLeftAlt');
  });

  it('matches the physical key under an IME (e.key is a glyph or Process)', () => {
    expect(resolveShortcut(ev({ key: 'ㅅ' }), win)).toBe('newSurface');
    expect(resolveShortcut(ev({ key: 'Process' }), win)).toBe('newSurface');
    expect(resolveShortcut(ev({ key: 'Process', code: 'Backquote' }), win)).toBe('floatingPane');
  });

  it('prefers the logical key on non-QWERTY layouts (#1227)', () => {
    // Dvorak: the key printed "t" sits where QWERTY has K.
    expect(resolveShortcut(ev({ key: 't', code: 'KeyK' }), win)).toBe('newSurface');
    // …and QWERTY's T position prints "y" there, which is nobody's binding.
    expect(resolveShortcut(ev({ key: 'y', code: 'KeyT' }), win)).toBeNull();
  });

  it('reaches shifted punctuation by its physical key', () => {
    // Windows reports '}' / '{' with Shift held (#1422).
    expect(resolveShortcut(ev({ key: '}', code: 'BracketRight', shiftKey: true }), win)).toBe('nextSurface');
    expect(resolveShortcut(ev({ key: '{', code: 'BracketLeft', shiftKey: true }), win)).toBe('prevSurface');
  });

  it('covers every zoom spelling the old handlers accepted', () => {
    const zoom = (over: Partial<ShortcutKeyEventLike>) => resolveShortcut(ev(over), win);
    expect(zoom({ key: '=', code: 'Equal' })).toBe('zoomIn');
    expect(zoom({ key: '+', code: 'Equal', shiftKey: true })).toBe('zoomIn');
    expect(zoom({ key: '+', code: 'NumpadAdd' })).toBe('zoomIn');
    expect(zoom({ key: '-', code: 'Minus' })).toBe('zoomOut');
    expect(zoom({ key: '_', code: 'Minus', shiftKey: true })).toBe('zoomOut');
    expect(zoom({ key: '-', code: 'NumpadSubtract' })).toBe('zoomOut');
    expect(zoom({ key: '0', code: 'Digit0' })).toBe('zoomReset');
    expect(zoom({ key: 'Insert', code: 'Numpad0' })).toBe('zoomReset');
    expect(zoom({ key: ')', code: 'Digit0', shiftKey: true })).toBeNull();
  });

  it('jumps to workspaces 1–9, by physical digit on AZERTY', () => {
    expect(resolveShortcut(ev({ key: '1', code: 'Digit1' }), win)).toBe('workspace1');
    expect(resolveShortcut(ev({ key: '&', code: 'Digit1' }), win)).toBe('workspace1');
    expect(resolveShortcut(ev({ key: '9', code: 'Digit9' }), win)).toBe('workspace9');
  });

  it('ignores a bare modifier keydown', () => {
    expect(resolveShortcut(ev({ key: 'Control', code: 'ControlLeft' }), win)).toBeNull();
  });
});

describe('effectiveBindings — the user\'s overrides', () => {
  const upAlt = ev({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: false, altKey: true });

  it('switching an action off frees its combo for the terminal (#1152, #1455)', () => {
    const b = effectiveBindings('win32', { prevWorkspace: null });
    expect(resolveShortcut(upAlt, b)).toBeNull();
    // Only that action: its pair keeps working.
    expect(resolveShortcut({ ...upAlt, key: 'ArrowDown', code: 'ArrowDown' }, b)).toBe('nextWorkspace');
  });

  it('moving an action rebinds it and releases the old combo', () => {
    const b = effectiveBindings('win32', { prevWorkspace: 'Ctrl+Alt+K' });
    expect(resolveShortcut(upAlt, b)).toBeNull();
    expect(resolveShortcut(ev({ key: 'k', code: 'KeyK', altKey: true }), b)).toBe('prevWorkspace');
  });

  it('an override replaces every alias of the action', () => {
    const b = effectiveBindings('win32', { zoomIn: 'Ctrl+Alt+=' });
    expect(resolveShortcut(ev({ key: '+', code: 'NumpadAdd' }), b)).toBeNull();
    expect(resolveShortcut(ev({ key: '=', code: 'Equal' }), b)).toBeNull();
    expect(resolveShortcut(ev({ key: '=', code: 'Equal', altKey: true }), b)).toBe('zoomIn');
  });

  it('a recorded ⌘ combo resolves on macOS', () => {
    const b = effectiveBindings('darwin', { commandPalette: 'Meta+Shift+P' });
    expect(resolveShortcut(ev({ key: 'P', code: 'KeyP', ctrlKey: false, metaKey: true, shiftKey: true }), b))
      .toBe('commandPalette');
  });
});

describe('comboFromEvent — recording a new binding', () => {
  it('spells the combo the resolver matches', () => {
    const e = ev({ key: 'k', code: 'KeyK', altKey: true });
    const combo = comboFromEvent(e);
    expect(combo).toBe('Ctrl+Alt+K');
    expect(resolveShortcut(e, [{ action: 'prevWorkspace', combo: combo as string }])).toBe('prevWorkspace');
  });

  it('records ⌘ as Meta', () => {
    expect(comboFromEvent(ev({ ctrlKey: false, metaKey: true, key: 'j', code: 'KeyJ' }))).toBe('Meta+J');
  });

  it('records the physical key when an IME gives a glyph', () => {
    expect(comboFromEvent(ev({ key: 'ㅅ' }))).toBe('Ctrl+T');
  });

  it('waits while only modifiers are held', () => {
    expect(comboFromEvent(ev({ key: 'Control', code: 'ControlLeft' }))).toBeNull();
  });
});

describe('override validation', () => {
  it('a combo needs Ctrl, ⌘ or Alt (or an F-key) — a bare key would eat typing', () => {
    expect(invalidShortcutCombo('K')).toBe('needsModifier');
    expect(invalidShortcutCombo('Shift+K')).toBe('needsModifier');
    expect(invalidShortcutCombo('Alt+K')).toBeNull();
    expect(invalidShortcutCombo('Meta+K')).toBeNull();
    expect(invalidShortcutCombo('Ctrl++')).toBeNull();
    expect(invalidShortcutCombo('F7')).toBeNull();
  });

  it('sanitize keeps configurable actions with pressable combos, and nothing else', () => {
    expect(sanitizeShortcutOverrides({
      prevWorkspace: null,
      nextWorkspace: 'Ctrl+Alt+J',
      newSurface: 'T',            // bare key — dropped
      notAnAction: 'Ctrl+Q',      // unknown — dropped
      splitVertical: 42,          // not a combo — dropped
    })).toEqual({ prevWorkspace: null, nextWorkspace: 'Ctrl+Alt+J' });
    expect(sanitizeShortcutOverrides(null)).toEqual({});
    expect(sanitizeShortcutOverrides(['Ctrl+T'])).toEqual({});
  });

  it('migrates #1152 disabled combos to per-action overrides', () => {
    expect(overridesFromDisabledCombos(['Ctrl+T', 'Ctrl+G', 'Ctrl+Alt+Delete', 7]))
      .toEqual({ newSurface: null, richInput: null });
    expect(overridesFromDisabledCombos(undefined)).toEqual({});
  });

  it('rebindProblem refuses what would leave a key or an action unreachable', () => {
    const b = defaultBindings('win32');
    expect(rebindProblem('prevWorkspace', 'Ctrl+Alt+K', b, 'win32', 'KeyB')).toBeNull();
    expect(rebindProblem('prevWorkspace', 'K', b, 'win32', 'KeyB')).toEqual({ kind: 'needsModifier' });
    expect(rebindProblem('prevWorkspace', 'Ctrl+C', b, 'win32', 'KeyB')).toEqual({ kind: 'clipboard' });
    expect(rebindProblem('prevWorkspace', 'Meta+V', b, 'darwin', 'KeyB')).toEqual({ kind: 'clipboard' });
    expect(rebindProblem('prevWorkspace', 'Ctrl+B', b, 'win32', 'KeyB')).toEqual({ kind: 'prefix' });
    expect(rebindProblem('prevWorkspace', 'Ctrl+T', b, 'win32', 'KeyB')).toEqual({ kind: 'taken', by: 'newSurface' });
    // Its own current combo is not a conflict.
    expect(rebindProblem('prevWorkspace', 'Alt+ArrowUp', b, 'win32', 'KeyB')).toBeNull();
  });
});

describe('prefix trigger', () => {
  it('is literal Ctrl + the configured physical key, on every OS', () => {
    expect(isPrefixTrigger(ev({ key: 'b', code: 'KeyB' }), 'KeyB')).toBe(true);
    expect(isPrefixTrigger(ev({ key: 'ㅠ', code: 'KeyB' }), 'KeyB')).toBe(true);
    expect(isPrefixTrigger(ev({ key: 'a', code: 'KeyA' }), 'KeyA')).toBe(true);
    expect(isPrefixTrigger(ev({ key: 'B', code: 'KeyB', shiftKey: true }), 'KeyB')).toBe(false);
    expect(isPrefixTrigger(ev({ key: 'b', code: 'KeyB', ctrlKey: false, metaKey: true }), 'KeyB')).toBe(false);
  });
});

describe('display', () => {
  it('concreteCombo turns the ⌘ family into Meta on macOS only', () => {
    expect(concreteCombo({ combo: 'Ctrl+Shift+D' }, 'darwin')).toBe('Meta+Shift+D');
    expect(concreteCombo({ combo: 'Ctrl+M', literalCtrl: true }, 'darwin')).toBe('Ctrl+M');
    expect(concreteCombo({ combo: 'Ctrl+Shift+D' }, 'win32')).toBe('Ctrl+Shift+D');
    expect(concreteCombo({ combo: 'Alt+ArrowUp' }, 'darwin')).toBe('Alt+ArrowUp');
  });

  it('labels keys the way the keyboard does', () => {
    expect(displayCombo('Meta+Shift+D', 'darwin')).toBe('⌘+Shift+D');
    expect(displayCombo('Alt+ArrowUp', 'darwin')).toBe('⌥+ArrowUp');
    expect(displayCombo('Ctrl+M', 'darwin')).toBe('Ctrl+M');
    expect(displayCombo('Alt+ArrowUp', 'win32')).toBe('Alt+ArrowUp');
    expect(displayCombo('Meta+K', 'win32')).toBe('Win+K');
  });
});

/**
 * #1280 — Ctrl+G (Rich Input) is a configurable row, which is what makes the
 * escape hatch reachable: turning it off hands the key back to the pane
 * (Claude Code's external editor, readline's abort).
 */
describe('Ctrl+G Rich Input row (#1280)', () => {
  it('is listed, so Settings renders it with a toggle', () => {
    const row = ADVERTISED_SHORTCUTS.find((e) => e.action === 'richInput');
    expect(row?.combo).toBe('Ctrl+G');
    expect(row?.descriptionKey).toBe('settings.sc.richInput');
    // Not literalCtrl: on macOS the binding is ⌘G, and Ctrl+G there stays a
    // readline byte.
    expect(row?.literalCtrl).toBeUndefined();
  });

  it('reserves its accelerator so the app menu can never claim Ctrl+G', () => {
    expect(collidesWithKeymap('CommandOrControl+G', 'win32')).toBe(true);
  });
});

/**
 * #1455 Windows dogfood — under a Hangul composition one Ctrl+T press is two
 * keydowns, `Process` then `t`, and both resolve. The guard lets every gate
 * act on the first and recognise the second as the same press.
 */
describe('ShortcutPressGuard (IME double keydown)', () => {
  const ev = (key: string, code: string, extra: Partial<ShortcutKeyEventLike> = {}) => ({
    key, code, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...extra,
  });

  it('the plain follow-up of an acted-on Process keydown is a duplicate', () => {
    const g = new ShortcutPressGuard();
    const first = ev('Process', 'KeyT');
    expect(g.isDuplicate(first)).toBe(false);
    g.noteActed(first);
    const second = ev('t', 'KeyT');
    expect(g.isDuplicate(second)).toBe(true);
    // Every gate the same keydown passes through gets the same answer.
    expect(g.isDuplicate(second)).toBe(true);
  });

  it('the acted-on keydown itself is never its own duplicate (later gates see it too)', () => {
    const g = new ShortcutPressGuard();
    const first = ev('Process', 'KeyT');
    g.noteActed(first);
    expect(g.isDuplicate(first)).toBe(false);
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(true);
  });

  it('is one-shot: a third keydown is a new press', () => {
    const g = new ShortcutPressGuard();
    g.noteActed(ev('Process', 'KeyT'));
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(true);
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(false);
  });

  it('a plain press never arms it', () => {
    const g = new ShortcutPressGuard();
    g.noteActed(ev('t', 'KeyT'));
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(false);
  });

  it('the press ending (keyup) disarms it', () => {
    const g = new ShortcutPressGuard();
    g.noteActed(ev('Process', 'KeyT'));
    g.onKeyUp({ code: 'KeyT' });
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(false);
  });

  it('another key, other modifiers or another IME keydown are not the follow-up', () => {
    const cases = [
      ev('w', 'KeyW'),
      ev('T', 'KeyT', { shiftKey: true }),
      ev('Process', 'KeyT'),
    ];
    for (const next of cases) {
      const g = new ShortcutPressGuard();
      g.noteActed(ev('Process', 'KeyT'));
      expect(g.isDuplicate(next)).toBe(false);
      // …and the guard is disarmed by it rather than left waiting.
      expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(false);
    }
  });

  it('a lone modifier keydown in between does not disarm it', () => {
    const g = new ShortcutPressGuard();
    g.noteActed(ev('Process', 'KeyT'));
    expect(g.isDuplicate(ev('Control', 'ControlLeft'))).toBe(false);
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(true);
  });

  it('a composed glyph arms it like Process does', () => {
    const g = new ShortcutPressGuard();
    g.noteActed(ev('ㅅ', 'KeyT'));
    expect(g.isDuplicate(ev('t', 'KeyT'))).toBe(true);
  });
});
