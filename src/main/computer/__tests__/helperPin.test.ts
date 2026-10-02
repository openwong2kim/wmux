import { describe, expect, it } from 'vitest';
import { WINDOWS_HELPER_PIN, effectiveHelperStatus } from '../helperPin';

const SIGNED = { sha256: 'f'.repeat(64), releaseSigned: true };

describe('packaged Windows helper gate', () => {
  it('reports a ready helper as missing in a packaged Windows build without a release signature or pin', () => {
    const opts = { platform: 'win32' as const, isPackaged: true };
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, releaseSigned: false } })).toBe('missing');
    expect(effectiveHelperStatus('ready', { ...opts, pin: { ...SIGNED, sha256: '' } })).toBe('missing');
    expect(effectiveHelperStatus('ready', { ...opts, pin: SIGNED })).toBe('ready');
  });

  it('leaves dev builds, other platforms and non-ready states alone', () => {
    const unsigned = { sha256: '', releaseSigned: false };
    expect(effectiveHelperStatus('ready', { platform: 'win32', isPackaged: false, pin: unsigned })).toBe('ready');
    expect(effectiveHelperStatus('ready', { platform: 'darwin', isPackaged: true, pin: unsigned })).toBe('ready');
    expect(effectiveHelperStatus('unsupported', { platform: 'win32', isPackaged: true, pin: SIGNED })).toBe('unsupported');
  });

  it('is empty outside a vite build', () => {
    expect(WINDOWS_HELPER_PIN).toEqual({ sha256: '', releaseSigned: false });
  });
});
