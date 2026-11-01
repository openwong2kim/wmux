import { describe, expect, it } from 'vitest';
import { typedPhotoTextMatcher } from '../chatBridge';

const DIR = '/Users/me/.wmux/uploads/phone';
const shot = (n: number) => `${DIR}/photo-2026-10-30T20-53-5${n}-000Z-0a1b2c3${n}.jpg`;
const matches = typedPhotoTextMatcher(DIR);

describe('typedPhotoTextMatcher', () => {
  it('pairs a photo-only steer with the placeholders Claude Code recorded', () => {
    const typed = [1, 2, 3, 4].map(shot).join(' ');
    expect(matches(typed, '[Image #4] [Image #5] [Image #6] [Image #7]')).toBe(true);
  });

  it('pairs words and photos, ignoring the space Claude Code drops after a placeholder', () => {
    expect(matches(`${shot(1)} ${shot(2)} this crashes  on launch`, '[Image #8] [Image #9]this crashes on launch')).toBe(true);
    expect(matches(`Find out why. ${shot(1)}`, 'Find out why. [Image #1]')).toBe(true);
  });

  it('keeps a placeholder the person typed literally on both sides', () => {
    expect(matches(`${shot(1)} what is [Image #1] here?`, '[Image #2] what is [Image #1] here?')).toBe(true);
  });

  it('does not pair when the counts differ or the words differ', () => {
    expect(matches(`${shot(1)} ${shot(2)}`, '[Image #1]')).toBe(false);
    expect(matches(shot(1), '[Image #1] [Image #2]')).toBe(false);
    expect(matches(`${shot(1)} hello`, '[Image #1] goodbye')).toBe(false);
  });

  it('needs a photo the upload route named: typed placeholders or other paths do not count', () => {
    expect(matches('look at [Image #1]', 'look at [Image #1]')).toBe(false);
    expect(matches('/tmp/other.png', '[Image #1]')).toBe(false);
    expect(matches(`${DIR}/photo-vacation.jpg`, '[Image #1]')).toBe(false);
    expect(typedPhotoTextMatcher(undefined)(shot(1), '[Image #1]')).toBe(false);
  });
});
