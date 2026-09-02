import { describe, expect, it } from 'vitest';
import { brandsForUserAgent, buildUserAgentOverride } from '../uaMetadata';

// Verbatim UA strings from Playwright's device table, plus the macOS desktop
// Chrome string the "chrome" backend runs under.
const UA = {
  desktopWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36',
  desktopMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36',
  iPhone13:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  pixel5:
    'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Mobile Safari/537.36',
  galaxyS9:
    'Mozilla/5.0 (Linux; Android 8.0.0; SM-G965U Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Mobile Safari/537.36',
};

describe('brandsForUserAgent', () => {
  it('reports Chromium and Google Chrome at the UA major version', () => {
    const brands = brandsForUserAgent(UA.desktopMac);
    expect(brands).toEqual(
      expect.arrayContaining([
        { brand: 'Chromium', version: '145' },
        { brand: 'Google Chrome', version: '145' },
      ]),
    );
    // Plus one greased entry, as real Chrome sends.
    expect(brands).toHaveLength(3);
  });

  it('reports no brands for a non-Chromium UA, because Safari exposes none', () => {
    expect(brandsForUserAgent(UA.iPhone13)).toEqual([]);
  });
});

describe('buildUserAgentOverride', () => {
  it('passes the UA string through untouched', () => {
    expect(buildUserAgentOverride(UA.desktopMac).userAgent).toBe(UA.desktopMac);
  });

  it('describes desktop Chrome on macOS', () => {
    const { userAgentMetadata: meta } = buildUserAgentOverride(UA.desktopMac);
    expect(meta.platform).toBe('macOS');
    expect(meta.platformVersion).toBe('10.15.7');
    expect(meta.architecture).toBe('x86');
    expect(meta.mobile).toBe(false);
    expect(meta.model).toBe('');
  });

  it('describes desktop Chrome on Windows', () => {
    const { userAgentMetadata: meta } = buildUserAgentOverride(UA.desktopWindows);
    expect(meta.platform).toBe('Windows');
    expect(meta.platformVersion).toBe('10.0.0');
    expect(meta.architecture).toBe('x86');
    expect(meta.mobile).toBe(false);
  });

  it('describes an iPhone preset as mobile iOS with no brands', () => {
    const { userAgentMetadata: meta } = buildUserAgentOverride(UA.iPhone13);
    expect(meta.platform).toBe('iOS');
    expect(meta.platformVersion).toBe('15.0.0');
    expect(meta.mobile).toBe(true);
    expect(meta.brands).toEqual([]);
    // Client Hints report neither on mobile.
    expect(meta.architecture).toBe('');
    expect(meta.model).toBe('');
  });

  it('describes an Android preset with its model', () => {
    const { userAgentMetadata: meta } = buildUserAgentOverride(UA.pixel5);
    expect(meta.platform).toBe('Android');
    expect(meta.platformVersion).toBe('11.0.0');
    expect(meta.mobile).toBe(true);
    expect(meta.model).toBe('Pixel 5');
    expect(meta.brands).toHaveLength(3);
  });

  it('strips the Build token out of an Android model', () => {
    const { userAgentMetadata: meta } = buildUserAgentOverride(UA.galaxyS9);
    expect(meta.model).toBe('SM-G965U');
    expect(meta.platformVersion).toBe('8.0.0');
  });

  it('carries the emulated locale as acceptLanguage, and omits it otherwise', () => {
    expect(buildUserAgentOverride(UA.desktopMac, 'fr-FR').acceptLanguage).toBe('fr-FR');
    expect(buildUserAgentOverride(UA.desktopMac).acceptLanguage).toBeUndefined();
    expect(buildUserAgentOverride(UA.desktopMac, null).acceptLanguage).toBeUndefined();
  });

  it('never leaves the metadata disagreeing with the UA about mobile', () => {
    for (const ua of Object.values(UA)) {
      const { userAgentMetadata: meta } = buildUserAgentOverride(ua);
      expect(meta.mobile).toBe(/Mobile|iPhone|iPad|Android/.test(ua));
    }
  });
});
