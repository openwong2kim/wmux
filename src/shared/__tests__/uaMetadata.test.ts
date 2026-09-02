import { describe, expect, it } from 'vitest';
import { brandsForUserAgent, buildUserAgentOverride, platformForUserAgent } from '../uaMetadata';

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
    const meta = buildUserAgentOverride(UA.desktopMac).userAgentMetadata;
    expect(meta?.platform).toBe('macOS');
    expect(meta?.platformVersion).toBe('10.15.7');
    expect(meta?.architecture).toBe('x86');
    expect(meta?.mobile).toBe(false);
    expect(meta?.model).toBe('');
  });

  it('describes desktop Chrome on Windows', () => {
    const meta = buildUserAgentOverride(UA.desktopWindows).userAgentMetadata;
    expect(meta?.platform).toBe('Windows');
    expect(meta?.platformVersion).toBe('10.0.0');
    expect(meta?.architecture).toBe('x86');
    expect(meta?.mobile).toBe(false);
  });

  it('omits the metadata entirely for a non-Chromium preset', () => {
    // Safari has no navigator.userAgentData at all. An empty-but-present hints
    // object is a shape no shipping browser produces, so it would be a
    // fingerprint of its own.
    const override = buildUserAgentOverride(UA.iPhone13);
    expect(override.userAgentMetadata).toBeUndefined();
    expect('userAgentMetadata' in override).toBe(false);
    expect(override.userAgent).toBe(UA.iPhone13);
  });

  it('still carries acceptLanguage for a non-Chromium preset', () => {
    expect(buildUserAgentOverride(UA.iPhone13, 'ja-JP').acceptLanguage).toBe('ja-JP');
  });

  it('describes an Android preset with its model', () => {
    const meta = buildUserAgentOverride(UA.pixel5).userAgentMetadata;
    expect(meta).toBeDefined();
    expect(meta?.platform).toBe('Android');
    expect(meta?.platformVersion).toBe('11.0.0');
    expect(meta?.mobile).toBe(true);
    expect(meta?.model).toBe('Pixel 5');
    expect(meta?.brands).toHaveLength(3);
    // Mobile Chrome reports neither architecture nor bitness.
    expect(meta?.architecture).toBe('');
    expect(meta?.bitness).toBe('');
  });

  it('strips the Build token out of an Android model', () => {
    const meta = buildUserAgentOverride(UA.galaxyS9).userAgentMetadata;
    expect(meta?.model).toBe('SM-G965U');
    expect(meta?.platformVersion).toBe('8.0.0');
  });

  it('fills the whole getHighEntropyValues shape for a Chromium preset', () => {
    const meta = buildUserAgentOverride(UA.desktopMac).userAgentMetadata;
    expect(meta?.bitness).toBe('64');
    expect(meta?.wow64).toBe(false);
    expect(meta?.fullVersion).toBe('145.0.7632.6');
    expect(meta?.fullVersionList).toEqual(
      expect.arrayContaining([
        { brand: 'Chromium', version: '145.0.7632.6' },
        { brand: 'Google Chrome', version: '145.0.7632.6' },
      ]),
    );
    expect(meta?.fullVersionList).toHaveLength(3);
    // The brand names must agree between the two lists.
    expect(meta?.fullVersionList.map((b) => b.brand)).toEqual(
      meta?.brands.map((b) => b.brand),
    );
  });

  it('carries the emulated locale as acceptLanguage, and omits it otherwise', () => {
    expect(buildUserAgentOverride(UA.desktopMac, 'fr-FR').acceptLanguage).toBe('fr-FR');
    expect(buildUserAgentOverride(UA.desktopMac).acceptLanguage).toBeUndefined();
    expect(buildUserAgentOverride(UA.desktopMac, null).acceptLanguage).toBeUndefined();
  });

  it('never leaves the metadata disagreeing with the UA about mobile', () => {
    for (const ua of Object.values(UA)) {
      const meta = buildUserAgentOverride(ua).userAgentMetadata;
      // Non-Chromium presets carry no metadata to disagree with.
      if (!meta) continue;
      expect(meta.mobile).toBe(/Mobile|iPhone|iPad|Android/.test(ua));
    }
  });
});

describe('platformForUserAgent', () => {
  // navigator.platform is the legacy string every browser still ships, and the
  // one an emulated iPhone used to answer "MacIntel" for — contradicting the UA
  // it had just announced. These are the values the real devices report, not
  // descriptions of them.
  it('reports what each emulated device actually reports', () => {
    expect(platformForUserAgent(UA.iPhone13)).toBe('iPhone');
    expect(platformForUserAgent(UA.pixel5)).toBe('Linux armv8l');
    expect(platformForUserAgent(UA.galaxyS9)).toBe('Linux armv8l');
    expect(platformForUserAgent(UA.desktopMac)).toBe('MacIntel');
    expect(platformForUserAgent(UA.desktopWindows)).toBe('Win32');
  });

  it('reads an iPad as an iPad, not as the Mac its UA mentions', () => {
    const iPad =
      'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
    expect(platformForUserAgent(iPad)).toBe('iPad');
  });

  it('reports desktop Linux distinctly from Android', () => {
    expect(
      platformForUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      ),
    ).toBe('Linux x86_64');
  });
});

describe('buildUserAgentOverride platform', () => {
  it('carries the platform on a Chromium preset', () => {
    expect(buildUserAgentOverride(UA.pixel5).platform).toBe('Linux armv8l');
  });

  it('carries the platform on a non-Chromium preset, which has no hints to carry it', () => {
    const override = buildUserAgentOverride(UA.iPhone13);
    expect(override.userAgentMetadata).toBeUndefined();
    expect(override.platform).toBe('iPhone');
  });

  it('omits the platform rather than reporting the empty string no browser reports', () => {
    const override = buildUserAgentOverride('Some/1.0 (unrecognised platform)');
    expect('platform' in override).toBe(false);
  });

  it('never leaves the platform disagreeing with the UA about the device', () => {
    for (const ua of Object.values(UA)) {
      const platform = buildUserAgentOverride(ua).platform!;
      expect(platform).not.toBe('');
      const isMobileUa = /iPhone|iPad|iPod|Android/.test(ua);
      expect(['iPhone', 'iPad', 'Linux armv8l'].includes(platform)).toBe(isMobileUa);
    }
  });
});
