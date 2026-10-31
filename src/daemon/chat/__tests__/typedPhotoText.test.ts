import { describe, expect, it } from 'vitest';
import { typedPhotoTextMatches } from '../chatBridge';

const DIR = '/Users/me/.wmux/uploads/phone';
const shot = (n: number) => `${DIR}/photo-2026-10-30T20-53-5${n}-000Z-0a1b2c3d.jpg`;

describe('typedPhotoTextMatches', () => {
  it('pairs a photo-only steer with the placeholders Claude Code recorded', () => {
    const typed = [1, 2, 3, 4].map(shot).join(' ');
    expect(typedPhotoTextMatches(typed, '[Image #4] [Image #5] [Image #6] [Image #7]', DIR)).toBe(true);
  });

  it('pairs words and photos, ignoring the space Claude Code drops after a placeholder', () => {
    expect(typedPhotoTextMatches(`${shot(1)} ${shot(2)} this crashes  on launch`, '[Image #8] [Image #9]this crashes on launch', DIR)).toBe(true);
    expect(typedPhotoTextMatches(`Find out why. ${shot(1)}`, 'Find out why. [Image #1]', DIR)).toBe(true);
  });

  it('does not pair when the counts differ or the words differ', () => {
    expect(typedPhotoTextMatches(`${shot(1)} ${shot(2)}`, '[Image #1]', DIR)).toBe(false);
    expect(typedPhotoTextMatches(shot(1), '[Image #1] [Image #2]', DIR)).toBe(false);
    expect(typedPhotoTextMatches(`${shot(1)} hello`, '[Image #1] goodbye', DIR)).toBe(false);
  });

  it('needs an upload path: typed placeholders or a path elsewhere do not count', () => {
    expect(typedPhotoTextMatches('look at [Image #1]', 'look at [Image #1]', DIR)).toBe(false);
    expect(typedPhotoTextMatches('/tmp/other.png', '[Image #1]', DIR)).toBe(false);
    expect(typedPhotoTextMatches(shot(1), '[Image #1]', undefined)).toBe(false);
  });
});
