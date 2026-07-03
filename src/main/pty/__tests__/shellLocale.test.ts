import { describe, expect, it } from 'vitest';
import { intlToPosixRegion, pickUtf8Locale } from '../shellLocale';

describe('intlToPosixRegion', () => {
  it('converts BCP-47 language-region to POSIX form', () => {
    expect(intlToPosixRegion('ko-KR')).toBe('ko_KR');
    expect(intlToPosixRegion('en-US')).toBe('en_US');
  });

  it('handles a script subtag between language and region', () => {
    expect(intlToPosixRegion('ko-Kore-KR')).toBe('ko_KR');
    expect(intlToPosixRegion('zh-Hans-CN')).toBe('zh_CN');
  });

  it('returns undefined when there is no region subtag', () => {
    expect(intlToPosixRegion('en')).toBeUndefined();
    expect(intlToPosixRegion('')).toBeUndefined();
  });
});

describe('pickUtf8Locale', () => {
  const available = [
    'C',
    'C.UTF-8',
    'POSIX',
    'en_US.UTF-8',
    'ko_KR',
    'ko_KR.UTF-8',
    'ja_JP.UTF-8',
  ];

  it('prefers the system region when it is installed', () => {
    expect(pickUtf8Locale(available, 'ko_KR')).toBe('ko_KR.UTF-8');
  });

  it('falls back to en_US.UTF-8 when the preferred region is not installed', () => {
    expect(pickUtf8Locale(available, 'fr_FR')).toBe('en_US.UTF-8');
  });

  it('falls back to en_US.UTF-8 when no region is known', () => {
    expect(pickUtf8Locale(available, undefined)).toBe('en_US.UTF-8');
  });

  it('falls back to C.UTF-8 when en_US.UTF-8 is absent', () => {
    expect(pickUtf8Locale(['C.UTF-8', 'de_DE.UTF-8'], 'fr_FR')).toBe('C.UTF-8');
  });

  it('picks any UTF-8 locale when neither en_US nor C are present', () => {
    expect(pickUtf8Locale(['de_DE.UTF-8'], undefined)).toBe('de_DE.UTF-8');
  });

  it('ignores non-UTF-8 locales entirely', () => {
    expect(pickUtf8Locale(['C', 'POSIX', 'ko_KR', 'ko_KR.eucKR'], 'ko_KR')).toBeUndefined();
  });

  it('matches the utf8 spelling variant case-insensitively', () => {
    expect(pickUtf8Locale(['en_US.utf8'], undefined)).toBe('en_US.utf8');
  });
});
