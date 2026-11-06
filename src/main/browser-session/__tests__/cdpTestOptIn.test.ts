import { describe, expect, it } from 'vitest';
import { cdpTestOptIn } from '../cdpTestOptIn';

const optedIn = { WMUX_TEST_CDP_PORT: '1' };

describe('cdpTestOptIn', () => {
  it('is honoured on an isolated instance', () => {
    for (const suffix of ['-dev', '-e2e-x', '-verify-a']) {
      expect(cdpTestOptIn({ env: optedIn, suffix, cdpEnabledInConfig: true })).toBe(true);
    }
  });

  it('is ignored on the default instance and on a portable copy', () => {
    for (const suffix of ['', '-portable']) {
      expect(cdpTestOptIn({ env: optedIn, suffix, cdpEnabledInConfig: true })).toBe(false);
    }
  });

  it('takes exactly "1"', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
      const env = value === undefined ? {} : { WMUX_TEST_CDP_PORT: value };
      expect(cdpTestOptIn({ env, suffix: '-e2e-x', cdpEnabledInConfig: true })).toBe(false);
    }
  });

  it('WMUX_DISABLE_CDP=true always wins', () => {
    const env = { ...optedIn, WMUX_DISABLE_CDP: 'true' };
    expect(cdpTestOptIn({ env, suffix: '-e2e-x', cdpEnabledInConfig: true })).toBe(false);
  });

  it('browser.cdp.enabled:false always wins', () => {
    expect(cdpTestOptIn({ env: optedIn, suffix: '-e2e-x', cdpEnabledInConfig: false })).toBe(false);
  });

  it('is true only when every rule holds (full table)', () => {
    for (const value of [undefined, '1']) {
      for (const suffix of ['', '-portable', '-dev', '-e2e-x']) {
        for (const disable of [undefined, 'true', 'false']) {
          for (const cdpEnabledInConfig of [true, false]) {
            const env: NodeJS.ProcessEnv = {};
            if (value !== undefined) env.WMUX_TEST_CDP_PORT = value;
            if (disable !== undefined) env.WMUX_DISABLE_CDP = disable;
            const expected =
              value === '1' && suffix !== '' && suffix !== '-portable' && disable !== 'true' && cdpEnabledInConfig;
            expect(cdpTestOptIn({ env, suffix, cdpEnabledInConfig }), JSON.stringify({ value, suffix, disable, cdpEnabledInConfig })).toBe(expected);
          }
        }
      }
    }
  });
});
