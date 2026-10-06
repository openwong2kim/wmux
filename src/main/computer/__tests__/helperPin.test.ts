import { describe, expect, it } from 'vitest';
import { WINDOWS_HELPER_PIN, effectiveHelperStatus, helperUnsignedNotice } from '../helperPin';

const SIGNED = { sha256: 'f'.repeat(64), releaseSigned: true };

describe('packaged Windows helper gate', () => {
  it('reports a pinned helper without a release signature as ready (4.0.0 Windows)', () => {
    const opts = { platform: 'win32' as const, isPackaged: true };
    // What every packaged Windows build carries while SignPath is not set up.
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, releaseSigned: false } })).toBe('ready');
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, releaseSigned: false }, selfElevated: true })).toBe('elevated');
    expect(helperUnsignedNotice({ ...opts, pin: { ...SIGNED, releaseSigned: false } })).toBe(true);
    expect(helperUnsignedNotice({ ...opts, pin: SIGNED })).toBe(false);
    expect(helperUnsignedNotice({ platform: 'win32', isPackaged: false, pin: { ...SIGNED, releaseSigned: false } })).toBe(false);
  });

  it('reports a packaged Windows build without a pin as missing, signed or not', () => {
    const opts = { platform: 'win32' as const, isPackaged: true };
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, sha256: '' } })).toBe('missing');
    expect(effectiveHelperStatus('ready', { ...opts, pin: { sha256: '', releaseSigned: false } })).toBe('missing');
    expect(effectiveHelperStatus('ready', { ...opts, pin: SIGNED })).toBe('ready');
  });

  it('leaves dev builds, other platforms and non-ready states alone', () => {
    const unsigned = { sha256: '', releaseSigned: false };
    expect(effectiveHelperStatus('ready', { platform: 'win32', isPackaged: false, pin: unsigned })).toBe('ready');
    expect(effectiveHelperStatus('ready', { platform: 'darwin', isPackaged: true, pin: unsigned })).toBe('ready');
    expect(effectiveHelperStatus('unsupported', { platform: 'win32', isPackaged: true, pin: SIGNED })).toBe('unsupported');
  });

  it('reports wmux running as administrator on Windows, dev builds included', () => {
    const unsigned = { sha256: '', releaseSigned: false };
    expect(effectiveHelperStatus('ready', { platform: 'win32', isPackaged: false, pin: unsigned, selfElevated: true })).toBe('elevated');
    expect(effectiveHelperStatus('ready', { platform: 'win32', isPackaged: true, pin: SIGNED, selfElevated: true })).toBe('elevated');
    // Unknown elevation leaves it to the helper's own refusal (exit 72).
    expect(effectiveHelperStatus('ready', { platform: 'win32', isPackaged: true, pin: SIGNED, selfElevated: null })).toBe('ready');
    expect(effectiveHelperStatus('ready', { platform: 'darwin', isPackaged: true, pin: SIGNED, selfElevated: true })).toBe('ready');
  });

  it('is empty outside a vite build', () => {
    expect(WINDOWS_HELPER_PIN).toEqual({ sha256: '', releaseSigned: false });
  });
});
