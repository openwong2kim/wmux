import { describe, it, expect } from 'vitest';
import { isPlausibleCwd } from '../cwdShape';

// Regression (2026-07-21): a pane's cwd was stored as the literal string "path"
// — a prompt-scrape false positive that the old win32 rule ("any non-empty
// string passes") let through, breaking the Git tab's repo resolution. A real
// cwd is always absolute (or ~-anchored); relative tokens are rejected on every
// platform.
describe('isPlausibleCwd — absolute-shape guard', () => {
  it('rejects a bare relative token on every platform (the "path" incident)', () => {
    for (const plat of ['win32', 'darwin', 'linux']) {
      expect(isPlausibleCwd('path', plat)).toBe(false);
      expect(isPlausibleCwd('some words', plat)).toBe(false);
      expect(isPlausibleCwd('rel/child', plat)).toBe(false);
    }
  });

  it('rejects the empty string', () => {
    expect(isPlausibleCwd('', 'win32')).toBe(false);
  });

  it('accepts Windows drive and UNC shapes on win32', () => {
    expect(isPlausibleCwd('C:\\Users\\me', 'win32')).toBe(true);
    expect(isPlausibleCwd('D:/wmux', 'win32')).toBe(true);
    expect(isPlausibleCwd('\\\\server\\share', 'win32')).toBe(true);
  });

  it('accepts POSIX-absolute paths on win32 (WSL panes)', () => {
    expect(isPlausibleCwd('/home/me/project', 'win32')).toBe(true);
  });

  it('accepts ~-anchored paths (bash \\w renders $HOME as ~)', () => {
    expect(isPlausibleCwd('~', 'linux')).toBe(true);
    expect(isPlausibleCwd('~/work', 'darwin')).toBe(true);
    expect(isPlausibleCwd('~/work', 'win32')).toBe(true);
  });

  it('still rejects Windows shapes on POSIX platforms (2026-07-20 incident)', () => {
    expect(isPlausibleCwd('C:\\Users\\me', 'darwin')).toBe(false);
    expect(isPlausibleCwd('\\\\server\\share', 'linux')).toBe(false);
  });

  it('accepts POSIX-absolute paths on POSIX platforms', () => {
    expect(isPlausibleCwd('/home/me', 'linux')).toBe(true);
    expect(isPlausibleCwd('/Users/me', 'darwin')).toBe(true);
  });

  it('rejects a ~-prefixed non-anchor token (e.g. "~foo" is a username ref, not a cwd we track)', () => {
    expect(isPlausibleCwd('~foo/bar', 'linux')).toBe(false);
  });
});
