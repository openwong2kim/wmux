// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDUCED_MOTION_ATTR, installSystemReducedMotion, prefersReducedMotion, setSystemReducedMotion, subscribeReducedMotion } from '../reducedMotion';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.documentElement.removeAttribute(REDUCED_MOTION_ATTR);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('system reduced motion in the renderer', () => {
  it('Windows: the answer from main sets the root attribute at start and again on focus', async () => {
    let answer = true;
    const read = vi.fn(async () => answer);
    cleanups.push(installSystemReducedMotion('win32', read));
    await flush();
    expect(document.documentElement.getAttribute(REDUCED_MOTION_ATTR)).toBe('true');
    expect(prefersReducedMotion()).toBe(true);
    answer = false;
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(document.documentElement.hasAttribute(REDUCED_MOTION_ATTR)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('macOS never asks: the media query alone decides there', async () => {
    const read = vi.fn(async () => true);
    cleanups.push(installSystemReducedMotion('darwin', read));
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute(REDUCED_MOTION_ATTR)).toBe(false);
  });

  it('subscribers hear a change of the attribute, once per change', () => {
    const heard = vi.fn();
    cleanups.push(subscribeReducedMotion(heard));
    setSystemReducedMotion(true);
    setSystemReducedMotion(true);
    setSystemReducedMotion(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
