import { describe, it, expect } from 'vitest';
import { shouldUseGlass } from '../windowGlass';

describe('shouldUseGlass', () => {
  it('is on for a dark theme on macOS', () => {
    expect(shouldUseGlass('darwin', '#171717')).toBe(true);
  });

  it('is off for a light theme on macOS', () => {
    expect(shouldUseGlass('darwin', '#F7F7F7')).toBe(false);
  });

  it('is off on Windows and Linux whatever the theme', () => {
    expect(shouldUseGlass('win32', '#171717')).toBe(false);
    expect(shouldUseGlass('linux', '#171717')).toBe(false);
    expect(shouldUseGlass(undefined, '#171717')).toBe(false);
  });

  it('is off when the theme opts out of glass', () => {
    expect(shouldUseGlass('darwin', '#09090B', '0')).toBe(false);
    expect(shouldUseGlass('darwin', '#1A171D', '1')).toBe(true);
  });

  it('is off when the base colour cannot be read', () => {
    expect(shouldUseGlass('darwin', '')).toBe(false);
    expect(shouldUseGlass('darwin', ' #171717 ')).toBe(true);
  });

  it('stays off on a light Mac, so nothing has to flip the app-wide appearance', () => {
    expect(shouldUseGlass('darwin', '#1A171D', '1', false)).toBe(false);
    expect(shouldUseGlass('darwin', '#1A171D', '1', true)).toBe(true);
  });
});
