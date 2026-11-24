// @wmux-lane unit
import { describe, it, expect } from 'vitest';
import { fixedFlyoutPosition } from '../fixedFlyoutPosition';

const vp = { width: 1000, height: 800 };
const size = { width: 140, height: 100 };

describe('fixedFlyoutPosition', () => {
  it('sits flush right of the row, level with its top', () => {
    expect(fixedFlyoutPosition({ left: 10, right: 218, top: 50 }, size, vp)).toEqual({ left: 218, top: 50 });
  });
  it('flips to the left of the row when the right edge would overflow', () => {
    expect(fixedFlyoutPosition({ left: 800, right: 900, top: 50 }, size, vp)).toEqual({ left: 660, top: 50 });
  });
  it('shifts up when the bottom would overflow', () => {
    expect(fixedFlyoutPosition({ left: 10, right: 218, top: 760 }, size, vp)).toEqual({ left: 218, top: 696 });
  });
});
