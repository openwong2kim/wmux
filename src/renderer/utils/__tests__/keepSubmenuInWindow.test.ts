import { describe, expect, it } from 'vitest';
import { fitMenuStart, fitSubmenuTop, submenuOpensLeft } from '../keepSubmenuInWindow';

describe('fitSubmenuTop', () => {
  it('leaves a submenu that fits where it opened', () => {
    expect(fitSubmenuTop(100, 200, 800)).toBe(0);
  });

  it('lifts a submenu that would run past the bottom edge', () => {
    // item at 700, 200 tall, window 800: 104px over (4px margin)
    expect(fitSubmenuTop(700, 200, 800)).toBe(-104);
  });

  it('never lifts the submenu above the top edge', () => {
    // taller than the window: pinned 4px from the top
    expect(fitSubmenuTop(300, 1000, 800)).toBe(-296);
  });
});

describe('fitMenuStart', () => {
  it('keeps a menu that fits at the pointer', () => {
    expect(fitMenuStart(100, 300, 800)).toBe(100);
  });

  it('moves a menu that would run past the edge back inside', () => {
    expect(fitMenuStart(700, 300, 800)).toBe(496);
  });

  it('pins a menu taller than the window 4px from the top', () => {
    expect(fitMenuStart(700, 1000, 800)).toBe(4);
  });
});

describe('submenuOpensLeft', () => {
  it('stays on the preferred side while it fits there', () => {
    expect(submenuOpensLeft(100, 200, 240, 800, false)).toBe(false);
    expect(submenuOpensLeft(500, 200, 240, 800, true)).toBe(true);
  });

  it('flips to the side with more room when the preferred side is too narrow', () => {
    // item spans 400..640 in an 800px window: 156px right, 396px left
    expect(submenuOpensLeft(400, 240, 240, 800, false)).toBe(true);
    // item spans 100..340: 96px left, 456px right
    expect(submenuOpensLeft(100, 240, 240, 800, true)).toBe(false);
  });

  it('keeps the preferred side when neither side has more room', () => {
    expect(submenuOpensLeft(10, 780, 240, 800, false)).toBe(false);
    expect(submenuOpensLeft(10, 780, 240, 800, true)).toBe(true);
  });
});
