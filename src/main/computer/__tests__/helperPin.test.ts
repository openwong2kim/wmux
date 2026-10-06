import { describe, expect, it } from 'vitest';
import { WINDOWS_HELPER_PIN, effectiveHelperStatus } from '../helperPin';

const SIGNED = { sha256: 'f'.repeat(64), releaseSigned: true };

describe('packaged Windows helper gate', () => {
  it('reports a shipped helper without a release signature as unsigned, not missing (4.0.0 Windows)', () => {
    const opts = { platform: 'win32' as const, isPackaged: true };
    // What every packaged Windows build carries until SignPath release-signs the helper.
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, releaseSigned: false } })).toBe('unsigned');
    expect(effectiveHelperStatus('ready', { ...opts, pin: { sha256: '', releaseSigned: false } })).toBe('unsigned');
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, releaseSigned: false }, selfElevated: true })).toBe('elevated');
  });

  it('reports a release-signed helper without a pin as missing', () => {
    const opts = { platform: 'win32' as const, isPackaged: true };
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, sha256: '' } })).toBe('missing');
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
