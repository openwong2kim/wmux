// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_HIDDEN_ATTR, REDUCED_MOTION_ATTR, installDocumentHiddenMotion, installSystemReducedMotion, prefersReducedMotion, setSystemReducedMotion, subscribeReducedMotion } from '../reducedMotion';

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

  it('a hidden window sets the root attribute, a shown one clears it, and uninstall stops listening', () => {
    let state: DocumentVisibilityState = 'hidden';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    try {
      const uninstall = installDocumentHiddenMotion();
      expect(document.documentElement.hasAttribute(DOCUMENT_HIDDEN_ATTR)).toBe(true);
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.documentElement.hasAttribute(DOCUMENT_HIDDEN_ATTR)).toBe(false);
      state = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.documentElement.hasAttribute(DOCUMENT_HIDDEN_ATTR)).toBe(true);
      uninstall();
      expect(document.documentElement.hasAttribute(DOCUMENT_HIDDEN_ATTR)).toBe(false);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.documentElement.hasAttribute(DOCUMENT_HIDDEN_ATTR)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
