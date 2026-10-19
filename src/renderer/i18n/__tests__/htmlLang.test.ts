// @vitest-environment jsdom
//
// The page's <html lang> follows the app's language (it stayed `en` in the
// Korean UI).
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../index';

describe('setLocale', () => {
  afterEach(() => setLocale('en'));

  it('sets <html lang> to the app locale, and back', () => {
    setLocale('ko');
    expect(document.documentElement.lang).toBe('ko');
    setLocale('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    setLocale('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
