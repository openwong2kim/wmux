import { describe, expect, it, vi } from 'vitest';
import { applyParentWindow, decodeNativeWindowHandle, isNativeWindowHandle } from '../conptyParentWindow';

const hwnd = Buffer.from([0x2a, 0x10, 0, 0, 0, 0, 0, 0]);

describe('applyParentWindow', () => {
  it('hands the HWND bytes to the pty and returns what it reports', () => {
    const setParentWindow = vi.fn(() => true);
    expect(applyParentWindow({ setParentWindow }, hwnd)).toBe(true);
    expect(setParentWindow).toHaveBeenCalledWith(hwnd);
  });

  it('reports false for a pty that cannot take an owner (in-box ConPTY, Unix)', () => {
    expect(applyParentWindow({ setParentWindow: () => false }, hwnd)).toBe(false);
  });

  it('is a no-op for a pty without the method (the Rust core, an older node-pty)', () => {
    expect(applyParentWindow({}, hwnd)).toBe(false);
  });

  it('never throws, even when node-pty does (a closed pty, a bad handle)', () => {
    const setParentWindow = vi.fn(() => { throw new Error('pty.reparent: hwnd must be a Buffer the size of an HWND'); });
    expect(applyParentWindow({ setParentWindow }, hwnd)).toBe(false);
  });

  it('sends nothing for no window or a handle that is not one HWND', () => {
    const setParentWindow = vi.fn(() => true);
    expect(applyParentWindow({ setParentWindow }, null)).toBe(false);
    expect(applyParentWindow({ setParentWindow }, Buffer.alloc(4))).toBe(false);
    expect(setParentWindow).not.toHaveBeenCalled();
  });

  it('never hands ConPTY a NULL owner (an all-zero HWND)', () => {
    const setParentWindow = vi.fn(() => true);
    expect(isNativeWindowHandle(Buffer.alloc(8))).toBe(false);
    expect(applyParentWindow({ setParentWindow }, Buffer.alloc(8))).toBe(false);
    expect(setParentWindow).not.toHaveBeenCalled();
  });
});

describe('decodeNativeWindowHandle', () => {
  it('round-trips the base64 wire form', () => {
    const decoded = decodeNativeWindowHandle(hwnd.toString('base64'));
    expect(decoded && isNativeWindowHandle(decoded)).toBe(true);
    expect(decoded?.equals(hwnd)).toBe(true);
  });

  it('takes null and an all-zero HWND alike as "no window"', () => {
    expect(decodeNativeWindowHandle(null)).toBeNull();
    expect(decodeNativeWindowHandle(Buffer.alloc(8).toString('base64'))).toBeNull();
  });

  it('refuses anything that is not exactly one HWND in canonical base64', () => {
    for (const bad of [undefined, 42, '', Buffer.alloc(4).toString('base64'), Buffer.alloc(16).toString('base64'), 'not base64!!', `${hwnd.toString('base64')}\n`]) {
      expect(decodeNativeWindowHandle(bad)).toBeUndefined();
    }
  });
});
