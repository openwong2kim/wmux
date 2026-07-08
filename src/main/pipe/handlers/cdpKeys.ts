// CDP key-event synthesis for browser.press.cdp (issue #353).
//
// A CDP `Input.dispatchKeyEvent {type:'char'}` inserts text but synthesizes NO
// `keydown`/`keyup` DOM events, so the old handler's `char` branch meant a page
// keydown listener never fired for ordinary keys. This module builds proper
// keyDown/keyUp descriptors instead: a printable character fires keydown AND
// inserts (via `text`), named keys map to real key codes, and modifier combos
// (Control+a) are parsed into the CDP modifier bitmask.
//
// Pure and Electron-free so the parsing table is unit-testable in isolation.
// Playwright's USKeyboardLayout is the reference behavior; only the keys the MCP
// browser tools actually press are tabled here.

/** CDP Input.dispatchKeyEvent modifier bitmask. */
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

interface NamedKey {
  key: string;
  code: string;
  vk: number;
  /** Present only where the key drives keypress/beforeinput (Enter, Space). */
  text?: string;
}

/** Named non-printable keys, keyed by lowercased name. */
const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};
// F1–F12 (virtual key codes 112–123).
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS['f' + i] = { key: 'F' + i, code: 'F' + i, vk: 111 + i };
}

export interface KeyDispatch {
  keyDown: Record<string, unknown>;
  keyUp: Record<string, unknown>;
}

/** Derive the CDP `code` for a single printable char where it's unambiguous. */
function deriveCode(ch: string): string | undefined {
  if (/^[a-zA-Z]$/.test(ch)) return 'Key' + ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
  return undefined;
}

/**
 * Parse a `[Modifier+]*Key` string into CDP keyDown/keyUp event params.
 *
 * Supported keys: any single printable character, the named keys in NAMED_KEYS,
 * and modifier combos (Control/Ctrl, Shift, Alt/Option, Meta/Cmd/Command).
 *
 * Throws on multi-character non-named input (e.g. "abc") — that is text, not a
 * key press; the caller should route it through browser.type.cdp instead.
 */
export function parseKeyPress(key: string): KeyDispatch {
  if (!key) throw new Error('parseKeyPress: empty key');

  // Split modifiers from the base key. A trailing '+' means the base key is the
  // literal '+' character (e.g. "Shift++" or a bare "+"); the final empty split
  // segment is that trailing '+'. A stray non-modifier before it (e.g. "a+") then
  // surfaces as an "unknown modifier" error rather than being silently dropped.
  const parts = key.split('+');
  let base: string;
  let modParts: string[];
  if (parts[parts.length - 1] === '') {
    base = '+';
    modParts = parts.slice(0, -1).filter((p) => p !== '');
  } else {
    base = parts[parts.length - 1];
    modParts = parts.slice(0, -1);
  }

  let modifiers = 0;
  for (const m of modParts) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (bit === undefined) {
      throw new Error(`parseKeyPress: unknown modifier "${m}" in "${key}"`);
    }
    modifiers |= bit;
  }
  // Control/Meta/Alt held ⇒ shortcut/accelerator semantics: suppress text so
  // e.g. Control+a selects all (not types "a") and Alt+key acts as a shortcut,
  // matching how browser automation treats these combos. (Panel review.)
  const isShortcut = (modifiers & (1 | 2 | 4)) !== 0;

  const named = NAMED_KEYS[base.toLowerCase()];
  if (named) {
    const shared: Record<string, unknown> = {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
      ...(modifiers ? { modifiers } : {}),
    };
    const keyDown: Record<string, unknown> = { ...shared, type: 'keyDown' };
    if (named.text !== undefined && !isShortcut) {
      keyDown.text = named.text;
      keyDown.unmodifiedText = named.text;
    }
    return { keyDown, keyUp: { ...shared, type: 'keyUp' } };
  }

  // Single printable character (UTF-16 code unit; astral chars fall through to
  // the reject below and should be typed via browser.type.cdp).
  if (base.length === 1) {
    // Shift + a letter produces the uppercase letter, both as the `key`/`text`
    // and as the inserted character. Shifted symbols (e.g. Shift+/ = ?) need a
    // full US-layout table we intentionally don't carry, so their glyph stays
    // best-effort — the base char is still inserted. (2-model panel finding.)
    const shifted = (modifiers & 8) !== 0 && /^[a-z]$/i.test(base);
    const outChar = shifted ? base.toUpperCase() : base;
    const cc = base.toUpperCase().charCodeAt(0);
    const code = deriveCode(base);
    const shared: Record<string, unknown> = {
      key: outChar,
      ...(code ? { code } : {}),
      windowsVirtualKeyCode: cc,
      nativeVirtualKeyCode: cc,
      ...(modifiers ? { modifiers } : {}),
    };
    const keyDown: Record<string, unknown> = { ...shared, type: 'keyDown' };
    if (!isShortcut) {
      // Fire keydown AND insert the char (keypress/beforeinput) in one event.
      keyDown.text = outChar;
      keyDown.unmodifiedText = outChar;
    }
    return { keyDown, keyUp: { ...shared, type: 'keyUp' } };
  }

  throw new Error(
    `parseKeyPress: unsupported key "${key}". Use a single character, a named key ` +
      `(Enter, Tab, Escape, Arrow*, Home, End, F1–F12, …), or a modifier combo ` +
      `(Control+a). To type multi-character text, use browser.type.cdp / browser_type instead.`,
  );
}
