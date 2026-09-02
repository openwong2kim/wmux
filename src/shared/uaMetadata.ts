// ---------------------------------------------------------------------------
// Client Hints that agree with the emulated User-Agent.
//
// `browser_emulate` used to override the UA string alone. The browser kept
// answering `navigator.userAgentData` — the Client Hints surface, and the
// `Sec-CH-UA*` request headers built from it — out of the *real* browser, so an
// emulated iPhone announced itself as an iPhone in one place and as desktop
// Chrome on macOS in the other. That disagreement is a stronger signal than
// either value on its own.
//
// This module derives the matching metadata from the preset's UA string so
// `Emulation.setUserAgentOverride` can carry both, plus the Accept-Language
// that should travel with them.
//
// It only ever runs on the emulate path. The default, non-emulated UA and its
// hints are the browser's own and are left untouched.
// ---------------------------------------------------------------------------

export interface UserAgentBrand {
  brand: string;
  version: string;
}

export interface UserAgentMetadata {
  brands: UserAgentBrand[];
  fullVersionList: UserAgentBrand[];
  fullVersion?: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
}

export interface UserAgentOverride {
  userAgent: string;
  /**
   * What `navigator.platform` answers. Not derived from `userAgentMetadata` —
   * a Safari UA carries no metadata at all, and an emulated iPhone that still
   * reported "MacIntel" contradicted its own UA string in the one property
   * every fingerprinting script reads first.
   *
   * Absent when the UA names no platform we recognise: leaving the real one in
   * place is a smaller lie than overriding it with the empty string, which no
   * browser reports.
   */
  platform?: string;
  /**
   * Absent for a non-Chromium preset. Chromium fills the Client Hints surface
   * from whatever it is given, so handing it `brands: []` would produce a
   * `navigator.userAgentData` that exists but is empty — a shape no real
   * browser has. Safari has no `userAgentData` at all, and omitting the field
   * is how you get that.
   */
  userAgentMetadata?: UserAgentMetadata;
  acceptLanguage?: string;
}

/**
 * The greased entry Chrome mixes into its brand list. Chrome varies it between
 * releases; any site that hard-codes a match on the list is already broken, so
 * a stable placeholder is honest enough and keeps the output deterministic.
 */
const GREASE_BRAND = 'Not_A Brand';
const GREASE_VERSION = '24';

function chromeMajorVersion(ua: string): string | undefined {
  const match = /Chrome\/(\d+)/.exec(ua);
  return match?.[1];
}

function chromeFullVersion(ua: string): string | undefined {
  const match = /Chrome\/([\d.]+)/.exec(ua);
  return match?.[1];
}

/**
 * Chromium's brand list for a given major version: the greased entry plus
 * Chromium and Google Chrome, which is the shape real Chrome reports.
 * A non-Chromium UA (Safari on iOS) gets an empty list — and callers must then
 * omit the metadata entirely rather than send the empty list, see
 * `UserAgentOverride.userAgentMetadata`.
 */
export function brandsForUserAgent(ua: string): UserAgentBrand[] {
  const major = chromeMajorVersion(ua);
  if (!major) return [];
  return [
    { brand: GREASE_BRAND, version: GREASE_VERSION },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
}

/**
 * The same list at full precision, which is what `getHighEntropyValues()`
 * returns for `fullVersionList`.
 */
export function fullVersionListForUserAgent(ua: string): UserAgentBrand[] {
  const full = chromeFullVersion(ua);
  if (!full) return [];
  return [
    { brand: GREASE_BRAND, version: `${GREASE_VERSION}.0.0.0` },
    { brand: 'Chromium', version: full },
    { brand: 'Google Chrome', version: full },
  ];
}

/**
 * `navigator.platform` for an emulated UA — the legacy string every browser
 * still ships, and the one a device preset used to leave answering out of the
 * real machine.
 *
 * These are the exact values the emulated browsers report, not descriptions of
 * them: iOS Safari says "iPhone"/"iPad", Chrome on Android says "Linux armv8l",
 * Chrome on macOS says "MacIntel" (on Apple silicon too), Windows "Win32"
 * (on 64-bit too) and desktop Linux "Linux x86_64".
 */
export function platformForUserAgent(ua: string): string {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Linux armv8l';
  if (/Macintosh|Mac OS X/.test(ua)) return 'MacIntel';
  if (/Windows/.test(ua)) return 'Win32';
  if (/Linux|X11/.test(ua)) return 'Linux x86_64';
  return '';
}

interface PlatformFacts {
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

function platformFactsFor(ua: string): PlatformFacts {
  // iPhone / iPad — the UA carries "CPU iPhone OS 15_0 like Mac OS X".
  const ios = /(?:iPhone|iPad|CPU) OS (\d+)[._](\d+)(?:[._](\d+))?/.exec(ua);
  if (/iPhone|iPad|iPod/.test(ua)) {
    return {
      platform: 'iOS',
      platformVersion: ios ? `${ios[1]}.${ios[2]}.${ios[3] ?? '0'}` : '',
      // Client Hints report no architecture or model on mobile.
      architecture: '',
      model: '',
      mobile: true,
    };
  }

  // Android — "Android 11; Pixel 5".
  const android = /Android (\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(ua);
  if (android) {
    const model = /Android [^;]+;\s*([^)]+?)(?:\s+Build\/[^)]*)?\)/.exec(ua)?.[1]?.trim() ?? '';
    return {
      platform: 'Android',
      platformVersion: `${android[1]}.${android[2] ?? '0'}.${android[3] ?? '0'}`,
      architecture: '',
      model,
      mobile: true,
    };
  }

  // macOS — "Macintosh; Intel Mac OS X 10_15_7".
  const mac = /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/.exec(ua);
  if (mac) {
    return {
      platform: 'macOS',
      platformVersion: `${mac[1]}.${mac[2]}.${mac[3] ?? '0'}`,
      architecture: 'x86',
      model: '',
      mobile: false,
    };
  }

  // Windows — "Windows NT 10.0". Chrome reports the marketing version here
  // (NT 10.0 covers both Windows 10 and 11); "10.0.0" is what Chrome on
  // Windows 10 sends.
  const win = /Windows NT (\d+)(?:\.(\d+))?/.exec(ua);
  if (win) {
    return {
      platform: 'Windows',
      platformVersion: `${win[1]}.${win[2] ?? '0'}.0`,
      architecture: 'x86',
      model: '',
      mobile: false,
    };
  }

  if (/Linux|X11/.test(ua)) {
    return { platform: 'Linux', platformVersion: '', architecture: 'x86', model: '', mobile: false };
  }

  return { platform: 'Unknown', platformVersion: '', architecture: '', model: '', mobile: false };
}

/**
 * Build the `Emulation.setUserAgentOverride` payload for an emulated UA.
 *
 * @param userAgent - the preset's UA string, taken verbatim.
 * @param locale    - the locale being emulated alongside it, if any. It becomes
 *                    `acceptLanguage` so the header agrees with the UA rather
 *                    than staying on the real browser's language.
 */
export function buildUserAgentOverride(
  userAgent: string,
  locale?: string | null,
): UserAgentOverride {
  const brands = brandsForUserAgent(userAgent);

  // Not Chromium (Safari on an iPhone/iPad preset): send the UA string alone,
  // so navigator.userAgentData stays absent as it is in the browser being
  // emulated. An empty-but-present hints object would be a fingerprint of its
  // own — no shipping browser produces one.
  const platform = platformForUserAgent(userAgent);

  if (brands.length === 0) {
    return {
      userAgent,
      ...(platform && { platform }),
      ...(locale && { acceptLanguage: locale }),
    };
  }

  const facts = platformFactsFor(userAgent);
  const fullVersion = chromeFullVersion(userAgent);

  return {
    userAgent,
    ...(platform && { platform }),
    userAgentMetadata: {
      brands,
      fullVersionList: fullVersionListForUserAgent(userAgent),
      ...(fullVersion && { fullVersion }),
      platform: facts.platform,
      platformVersion: facts.platformVersion,
      architecture: facts.architecture,
      model: facts.model,
      mobile: facts.mobile,
      // getHighEntropyValues reports these too; a desktop Chrome that answers
      // for architecture but not for bitness is not a shape Chrome produces.
      // Mobile reports neither, matching architecture/model above.
      bitness: facts.mobile ? '' : '64',
      wow64: false,
    },
    ...(locale && { acceptLanguage: locale }),
  };
}
