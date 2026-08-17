import { describe, it, expect } from 'vitest';
import { placePopover } from '../placePopover';

describe('placePopover', () => {
  it('aligns to the anchor right edge and sits below it', () => {
    const pos = placePopover(
      { top: 40, left: 800, right: 900, bottom: 70 },
      { width: 200, height: 100 },
    );
    expect(pos.left).toBe(700);
    expect(pos.top).toBe(74);
  });

  it('flips above when the popover would overflow the bottom', () => {
    const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
    const pos = placePopover(
      { top: vh - 20, left: 100, right: 200, bottom: vh - 4 },
      { width: 200, height: 300 },
    );
    expect(pos.top).toBeLessThan(vh - 20);
  });
});
