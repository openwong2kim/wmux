import { describe, expect, it } from 'vitest';
import { pageZoomKey, stepPageZoom, type ZoomKeyInput } from '../browserZoom';

const key = (k: Partial<ZoomKeyInput>): ZoomKeyInput => ({ type: 'keyDown', key: '', control: false, meta: false, alt: false, ...k });

describe('stepPageZoom', () => {
  it("walks Chrome's steps and stops at the ends", () => {
    expect(stepPageZoom(1, 'in')).toBe(1.1);
    expect(stepPageZoom(1, 'out')).toBe(0.9);
    expect(stepPageZoom(5, 'in')).toBe(5);
    expect(stepPageZoom(0.25, 'out')).toBe(0.25);
    expect(stepPageZoom(2.5, 'reset')).toBe(1);
  });

  it('moves a factor between steps to the nearest step in that direction', () => {
    expect(stepPageZoom(1.2, 'in')).toBe(1.25);
    expect(stepPageZoom(1.2, 'out')).toBe(1.1);
  });
});

describe('pageZoomKey', () => {
  it('reads Cmd on macOS and Ctrl elsewhere, with shifted and numpad spellings', () => {
    expect(pageZoomKey(key({ meta: true, key: '=' }), 'darwin')).toBe('in');
    expect(pageZoomKey(key({ meta: true, key: '+' }), 'darwin')).toBe('in');
    expect(pageZoomKey(key({ control: true, key: '-' }), 'win32')).toBe('out');
    expect(pageZoomKey(key({ control: true, key: 'x', code: 'NumpadAdd' }), 'linux')).toBe('in');
    expect(pageZoomKey(key({ control: true, key: '0' }), 'win32')).toBe('reset');
  });

  it('leaves other keys and modifiers to the page', () => {
    expect(pageZoomKey(key({ control: true, key: '=' }), 'darwin')).toBeNull();
    expect(pageZoomKey(key({ meta: true, key: '=' }), 'win32')).toBeNull();
    expect(pageZoomKey(key({ meta: true, alt: true, key: '=' }), 'darwin')).toBeNull();
    expect(pageZoomKey(key({ meta: true, key: 'r' }), 'darwin')).toBeNull();
    expect(pageZoomKey(key({ control: true, key: 'Insert', code: 'Numpad0' }), 'win32')).toBeNull();
    expect(pageZoomKey(key({ type: 'keyUp', meta: true, key: '=' }), 'darwin')).toBeNull();
  });
});
