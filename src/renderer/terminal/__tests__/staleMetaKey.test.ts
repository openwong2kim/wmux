import { describe, it, expect } from 'vitest';
import { createStaleMetaNotice, resolveStaleMetaText, type StaleMetaKeyEvent, type StaleMetaKeyContext } from '../staleMetaKey';

const key = (over: Partial<StaleMetaKeyEvent> = {}): StaleMetaKeyEvent => ({
  key: ' ', keyCode: 32, metaKey: true, ctrlKey: false, altKey: false, isComposing: false, ...over,
});
const ctx = (over: Partial<StaleMetaKeyContext> = {}): StaleMetaKeyContext => ({
  platform: 'win32', staleMods: ['Meta'], xtermEncodes: false, ...over,
});

describe('resolveStaleMetaText (#1950 recovery)', () => {
  it('types Space and letters that carry a stale Meta on Windows', () => {
    expect(resolveStaleMetaText(key(), ctx())).toBe(' ');
    expect(resolveStaleMetaText(key({ key: 'f', keyCode: 70 }), ctx())).toBe('f');
  });

  it('keeps Shift, which is already folded into the key', () => {
    expect(resolveStaleMetaText(key({ key: 'F', keyCode: 70 }), ctx({ staleMods: ['Shift', 'Meta'] }))).toBe('F');
    expect(resolveStaleMetaText(key({ key: '!', keyCode: 49 }), ctx())).toBe('!');
  });

  it('types a non-Latin character from the layout', () => {
    expect(resolveStaleMetaText(key({ key: 'ą', keyCode: 65 }), ctx())).toBe('ą');
  });

  it('leaves a Win key that is really held alone', () => {
    expect(resolveStaleMetaText(key(), ctx({ staleMods: [] }))).toBeNull();
    // Only another modifier is stale: the Meta has a press behind it.
    expect(resolveStaleMetaText(key(), ctx({ staleMods: ['Shift'] }))).toBeNull();
  });

  it('only acts on Windows', () => {
    expect(resolveStaleMetaText(key(), ctx({ platform: 'darwin' }))).toBeNull();
    expect(resolveStaleMetaText(key(), ctx({ platform: 'linux' }))).toBeNull();
    expect(resolveStaleMetaText(key(), ctx({ platform: undefined }))).toBeNull();
  });

  it('needs the Meta flag and no Ctrl or Alt', () => {
    expect(resolveStaleMetaText(key({ metaKey: false }), ctx({ staleMods: [] }))).toBeNull();
    expect(resolveStaleMetaText(key({ ctrlKey: true }), ctx({ staleMods: ['Ctrl', 'Meta'] }))).toBeNull();
    expect(resolveStaleMetaText(key({ altKey: true }), ctx({ staleMods: ['Alt', 'Meta'] }))).toBeNull();
  });

  it('defers to an IME', () => {
    expect(resolveStaleMetaText(key({ isComposing: true }), ctx())).toBeNull();
    expect(resolveStaleMetaText(key({ key: 'Process', keyCode: 229 }), ctx())).toBeNull();
    expect(resolveStaleMetaText(key({ key: 'ㅎ', keyCode: 229 }), ctx())).toBeNull();
  });

  it('leaves a kitty-negotiated pane to xterm', () => {
    expect(resolveStaleMetaText(key(), ctx({ xtermEncodes: true }))).toBeNull();
  });

  it('ignores named keys and control characters', () => {
    for (const k of ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'F2', 'Dead', 'Meta', 'Unidentified']) {
      expect(resolveStaleMetaText(key({ key: k, keyCode: 0 }), ctx())).toBeNull();
    }
    expect(resolveStaleMetaText(key({ key: '\u0007', keyCode: 0 }), ctx())).toBeNull();
    expect(resolveStaleMetaText(key({ key: '\u007f', keyCode: 0 }), ctx())).toBeNull();
  });

  it('types a character outside the BMP as one key', () => {
    expect(resolveStaleMetaText(key({ key: '😀', keyCode: 0 }), ctx())).toBe('😀');
  });
});

describe('createStaleMetaNotice', () => {
  it('logs once per focus session', () => {
    const n = createStaleMetaNotice();
    expect(n.shouldLog(0)).toBe(true);
    expect(n.shouldLog(0)).toBe(false);
    expect(n.shouldLog(1)).toBe(true);
    expect(n.shouldLog(1)).toBe(false);
  });
});
