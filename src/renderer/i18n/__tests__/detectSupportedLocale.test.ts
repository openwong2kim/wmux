import { describe, it, expect } from 'vitest';
import { detectSupportedLocale, LOCALE_OPTIONS } from '../index';

describe('detectSupportedLocale', () => {
  it('matches a plain supported code exactly', () => {
    expect(detectSupportedLocale('pl')).toBe('pl');
    expect(detectSupportedLocale('en')).toBe('en');
  });

  it('strips a region subtag when the base language is supported', () => {
    expect(detectSupportedLocale('pl-PL')).toBe('pl');
    expect(detectSupportedLocale('de-AT')).toBe('de');
    expect(detectSupportedLocale('fr-CA')).toBe('fr');
  });

  it('matches case-insensitively', () => {
    expect(detectSupportedLocale('PL-pl')).toBe('pl');
    expect(detectSupportedLocale('DE')).toBe('de');
  });

  it('matches the exact region-qualified ids we ship (zh-TW, pt-BR)', () => {
    expect(detectSupportedLocale('zh-TW')).toBe('zh-TW');
    expect(detectSupportedLocale('pt-BR')).toBe('pt-BR');
  });

  it('routes zh by script/region: Traditional-leaning signals go to zh-TW, everything else to zh', () => {
    expect(detectSupportedLocale('zh-Hant-TW')).toBe('zh-TW');
    expect(detectSupportedLocale('zh-HK')).toBe('zh-TW');
    expect(detectSupportedLocale('zh-MO')).toBe('zh-TW');
    expect(detectSupportedLocale('zh-CN')).toBe('zh');
    expect(detectSupportedLocale('zh-Hans')).toBe('zh');
    expect(detectSupportedLocale('zh')).toBe('zh');
  });

  it('falls back to English for a language we do not ship', () => {
    // Swedish is not in LOCALE_OPTIONS today — if that ever changes, swap the
    // fixture for another genuinely unsupported code rather than deleting
    // the assertion.
    expect(LOCALE_OPTIONS.some((o) => (o.value as string) === 'sv')).toBe(false);
    expect(detectSupportedLocale('sv-SE')).toBe('en');
    expect(detectSupportedLocale('sv')).toBe('en');
  });

  it('falls back to English for empty, whitespace, or garbage input — never throws', () => {
    expect(detectSupportedLocale('')).toBe('en');
    expect(detectSupportedLocale('   ')).toBe('en');
    expect(detectSupportedLocale('not-a-locale-at-all')).toBe('en');
    expect(detectSupportedLocale(undefined as unknown as string)).toBe('en');
  });

  it('respects an injected supported-locale list instead of the module default', () => {
    expect(detectSupportedLocale('pl-PL', ['en', 'de'])).toBe('en');
    expect(detectSupportedLocale('de-DE', ['en', 'de'])).toBe('de');
  });
});
