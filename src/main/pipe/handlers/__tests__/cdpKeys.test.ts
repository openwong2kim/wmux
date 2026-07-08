import { describe, expect, it } from 'vitest';
import { parseKeyPress } from '../cdpKeys';

// Pure parsing coverage for the browser.press.cdp key table (#353). The bug was
// that ordinary keys never produced a DOM keydown; these assert the descriptors
// now carry keyDown + text, that modifiers parse, and that shortcut combos
// suppress text.

describe('parseKeyPress — printable characters', () => {
  it("'z' fires keyDown with text (keydown + insertion) and a matching keyUp", () => {
    const { keyDown, keyUp } = parseKeyPress('z');
    expect(keyDown).toMatchObject({
      type: 'keyDown',
      key: 'z',
      code: 'KeyZ',
      text: 'z',
      unmodifiedText: 'z',
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
    });
    expect(keyDown).not.toHaveProperty('modifiers');
    expect(keyUp).toMatchObject({ type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
    // keyUp must not re-insert the character.
    expect(keyUp).not.toHaveProperty('text');
  });

  it("digit '5' derives DigitN code and its virtual key code", () => {
    const { keyDown } = parseKeyPress('5');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: '5', code: 'Digit5', text: '5', windowsVirtualKeyCode: 53 });
  });

  it('a symbol still fires keyDown+text but omits code (not unambiguously derivable)', () => {
    const { keyDown } = parseKeyPress('/');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: '/', text: '/' });
    expect(keyDown).not.toHaveProperty('code');
  });
});

describe('parseKeyPress — named keys', () => {
  it("'Enter' carries text '\\r' so keypress/beforeinput fire", () => {
    const { keyDown, keyUp } = parseKeyPress('Enter');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(keyUp).toMatchObject({ type: 'keyUp', key: 'Enter' });
    expect(keyUp).not.toHaveProperty('text');
  });

  it("'ArrowDown' maps to vk 40 with no text", () => {
    const { keyDown } = parseKeyPress('ArrowDown');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    expect(keyDown).not.toHaveProperty('text');
  });

  it("'Space' inserts a space", () => {
    const { keyDown } = parseKeyPress('Space');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
  });

  it('is case-insensitive on the key name and covers F-keys', () => {
    expect(parseKeyPress('escape').keyDown).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 });
    expect(parseKeyPress('f12').keyDown).toMatchObject({ key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
  });
});

describe('parseKeyPress — modifier combos', () => {
  it("'Control+a' sets modifiers=2 and suppresses text (shortcut, not typing)", () => {
    const { keyDown, keyUp } = parseKeyPress('Control+a');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    expect(keyDown).not.toHaveProperty('text');
    expect(keyUp).toMatchObject({ type: 'keyUp', modifiers: 2 });
  });

  it("'Meta+c' sets modifiers=4 and suppresses text", () => {
    const { keyDown } = parseKeyPress('Meta+c');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'c', modifiers: 4 });
    expect(keyDown).not.toHaveProperty('text');
  });

  it("'Shift+Tab' sets modifiers=8 on a named key", () => {
    const { keyDown } = parseKeyPress('Shift+Tab');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 });
  });

  it('combines multiple modifiers (Control+Shift = 2|8 = 10), key uppercased by Shift', () => {
    const { keyDown } = parseKeyPress('Control+Shift+k');
    expect(keyDown).toMatchObject({ key: 'K', modifiers: 10 }); // Shift → 'K'
    expect(keyDown).not.toHaveProperty('text'); // Control held → shortcut, no insert
  });

  it('accepts Ctrl / Cmd aliases', () => {
    expect(parseKeyPress('Ctrl+a').keyDown).toMatchObject({ modifiers: 2 });
    expect(parseKeyPress('Cmd+v').keyDown).toMatchObject({ modifiers: 4 });
  });

  it("'Shift+a' inserts the uppercase letter 'A' (not 'a')", () => {
    const { keyDown } = parseKeyPress('Shift+a');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 });
  });

  it("'Alt+a' is treated as a shortcut and suppresses text", () => {
    const { keyDown } = parseKeyPress('Alt+a');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: 'a', modifiers: 1 });
    expect(keyDown).not.toHaveProperty('text');
  });
});

describe("parseKeyPress — the literal '+' key and malformed input", () => {
  it("a bare '+' presses the plus key and inserts it", () => {
    const { keyDown } = parseKeyPress('+');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: '+', text: '+' });
    expect(keyDown).not.toHaveProperty('modifiers');
  });

  it("'Control++' presses '+' with the Control modifier", () => {
    const { keyDown } = parseKeyPress('Control++');
    expect(keyDown).toMatchObject({ type: 'keyDown', key: '+', modifiers: 2 });
    expect(keyDown).not.toHaveProperty('text'); // Control → shortcut
  });

  it("'a+' errors clearly instead of silently dropping the 'a'", () => {
    expect(() => parseKeyPress('a+')).toThrow(/unknown modifier "a"/i);
  });
});

describe('parseKeyPress — rejects', () => {
  it('throws on multi-character text, pointing at browser.type.cdp', () => {
    expect(() => parseKeyPress('abc')).toThrow(/browser\.type\.cdp/);
  });

  it('throws on an unknown modifier', () => {
    expect(() => parseKeyPress('Hyper+a')).toThrow(/unknown modifier/i);
  });

  it('throws on empty input', () => {
    expect(() => parseKeyPress('')).toThrow(/empty key/i);
  });
});
