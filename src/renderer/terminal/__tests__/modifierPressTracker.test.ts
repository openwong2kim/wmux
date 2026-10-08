import { describe, it, expect } from 'vitest';
import {
  createModifierPressTracker,
  formatModifiers,
  modifierOfCode,
  modifiersOf,
} from '../modifierPressTracker';

const flags = (over: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over,
});

describe('modifierPressTracker (#1950 diagnostics)', () => {
  it('maps modifier codes, ignores other keys', () => {
    expect(modifierOfCode('MetaLeft')).toBe('Meta');
    expect(modifierOfCode('MetaRight')).toBe('Meta');
    expect(modifierOfCode('ControlRight')).toBe('Ctrl');
    expect(modifierOfCode('AltLeft')).toBe('Alt');
    expect(modifierOfCode('ShiftLeft')).toBe('Shift');
    expect(modifierOfCode('Space')).toBeNull();
    expect(modifierOfCode('KeyF')).toBeNull();
  });

  it('formats the flags a key carries', () => {
    expect(formatModifiers(modifiersOf(flags()))).toBe('none');
    expect(formatModifiers(modifiersOf(flags({ metaKey: true })))).toBe('Meta');
    expect(formatModifiers(modifiersOf(flags({ shiftKey: true, ctrlKey: true })))).toBe('Ctrl+Shift');
  });

  it('a Meta flag with no Meta press behind it is stale (the #1950 shape)', () => {
    const t = createModifierPressTracker();
    // Space arrives with metaKey set, but this window never saw the Win key.
    expect(t.staleModifiers(flags({ metaKey: true }))).toEqual(['Meta']);
    expect(t.staleModifiers(flags())).toEqual([]);
  });

  it('a held modifier is not stale until its keyup', () => {
    const t = createModifierPressTracker();
    t.onKeyDown({ code: 'MetaLeft' });
    expect(t.staleModifiers(flags({ metaKey: true }))).toEqual([]);
    t.onKeyDown({ code: 'ShiftLeft' });
    expect(t.staleModifiers(flags({ metaKey: true, shiftKey: true }))).toEqual([]);
    t.onKeyUp({ code: 'MetaLeft' });
    expect(t.staleModifiers(flags({ metaKey: true, shiftKey: true }))).toEqual(['Meta']);
  });

  it('losing focus forgets presses, so a keyup that lands elsewhere cannot hide a stale flag', () => {
    // Win+Shift+S: the Win keydown reaches wmux, the overlay takes focus, the
    // keyup goes to the overlay. Back in wmux, a Meta flag is no longer backed
    // by a press this window saw.
    const t = createModifierPressTracker();
    t.onKeyDown({ code: 'MetaLeft' });
    t.onKeyDown({ code: 'ShiftLeft' });
    t.onBlur();
    expect(t.staleModifiers(flags({ metaKey: true }))).toEqual(['Meta']);
    expect(t.staleModifiers(flags({ shiftKey: true }))).toEqual(['Shift']);
  });

  it('ordinary keys never count as a modifier press', () => {
    const t = createModifierPressTracker();
    t.onKeyDown({ code: 'KeyF' });
    t.onKeyDown({ code: 'Space' });
    expect(t.staleModifiers(flags({ ctrlKey: true }))).toEqual(['Ctrl']);
  });
});
