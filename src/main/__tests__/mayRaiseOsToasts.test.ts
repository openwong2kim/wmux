// @wmux-lane unit
// The platform is a plain string argument to a pure function; nothing here
// reaches the OS.
//
// #2964: Electron's Windows toast setup names Start Menu\Programs\<ProductName>.lnk,
// so an isolated packaged copy must not raise OS toasts.
import { describe, expect, it } from 'vitest';
import { mayRaiseOsToasts } from '../dataIsolation';

describe('mayRaiseOsToasts', () => {
  it('the installed app (packaged, no suffix) keeps its toasts on Windows', () => {
    expect(mayRaiseOsToasts('win32', true, {})).toBe(true);
    expect(mayRaiseOsToasts('win32', true, { WMUX_DATA_SUFFIX: '' })).toBe(true);
  });

  it('never an isolated packaged copy on Windows: portable, a test run, a verification run', () => {
    expect(mayRaiseOsToasts('win32', true, { WMUX_DATA_SUFFIX: '-portable' })).toBe(false);
    expect(mayRaiseOsToasts('win32', true, { WMUX_DATA_SUFFIX: '-e2e-first-run-abc123' })).toBe(false);
    expect(mayRaiseOsToasts('win32', true, { WMUX_DATA_SUFFIX: '-verify-x' })).toBe(false);
  });

  it("an unpackaged dev build keeps toasts: Electron names the link after electron.exe's own ProductName", () => {
    expect(mayRaiseOsToasts('win32', false, { WMUX_DATA_SUFFIX: '-dev' })).toBe(true);
  });

  it('other platforms are unaffected', () => {
    expect(mayRaiseOsToasts('darwin', true, { WMUX_DATA_SUFFIX: '-portable' })).toBe(true);
    expect(mayRaiseOsToasts('linux', true, { WMUX_DATA_SUFFIX: '-verify-x' })).toBe(true);
  });
});
