import { describe, expect, it } from 'vitest';
import { systemPrefersReducedMotion } from '../reducedMotion';

const settings = (prefersReducedMotion: boolean, shouldRenderRichAnimation: boolean) => () => ({ prefersReducedMotion, shouldRenderRichAnimation });

describe('systemPrefersReducedMotion', () => {
  it('Windows: Animation effects off reads as reduced motion, from the live field', () => {
    expect(systemPrefersReducedMotion('win32', settings(false, false))).toBe(true);
    expect(systemPrefersReducedMotion('win32', settings(false, true))).toBe(false);
    // A stale cached prefersReducedMotion after the setting was turned back on.
    expect(systemPrefersReducedMotion('win32', settings(true, true))).toBe(false);
  });

  it('macOS and Linux are left to the media query', () => {
    expect(systemPrefersReducedMotion('darwin', settings(true, false))).toBe(false);
    expect(systemPrefersReducedMotion('linux', settings(true, false))).toBe(false);
  });

  it('a setting that cannot be read is no reduced motion', () => {
    expect(systemPrefersReducedMotion('win32', () => { throw new Error('unavailable'); })).toBe(false);
  });
});
