import { describe, expect, it } from 'vitest';
import { cdpTestOptIn } from '../cdpTestOptIn';

const optedIn = { WMUX_TEST_CDP_PORT: '1' };

describe('cdpTestOptIn', () => {
  it('is honoured on an isolated instance', () => {
    for (const suffix of ['-dev', '-e2e-x', '-verify-a']) {
      expect(cdpTestOptIn({ env: optedIn, suffix, cdpEnabled: true })).toBe(true);
    }
  });

  it('is ignored on the default instance and on a portable copy', () => {
    for (const suffix of ['', '-portable']) {
      expect(cdpTestOptIn({ env: optedIn, suffix, cdpEnabled: true })).toBe(false);
    }
  });

  it('takes exactly "1"', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
      const env = value === undefined ? {} : { WMUX_TEST_CDP_PORT: value };
      expect(cdpTestOptIn({ env, suffix: '-e2e-x', cdpEnabled: true })).toBe(false);
    }
  });

  it('a disabled CDP always wins', () => {
    for (const suffix of ['-dev', '-e2e-x']) {
      expect(cdpTestOptIn({ env: optedIn, suffix, cdpEnabled: false })).toBe(false);
    }
  });

  it('decides on cdpEnabled alone, without re-reading WMUX_DISABLE_CDP', () => {
    // The caller passes the value the port decision computed; the helper does
    // not keep a second copy of that rule.
    expect(cdpTestOptIn({ env: { ...optedIn, WMUX_DISABLE_CDP: 'true' }, suffix: '-e2e-x', cdpEnabled: true })).toBe(true);
  });

  it('is true only when every rule holds (full table)', () => {
    for (const value of [undefined, '0', '1']) {
      for (const suffix of ['', '-portable', '-dev', '-e2e-x']) {
        for (const cdpEnabled of [true, false]) {
          const env: NodeJS.ProcessEnv = value === undefined ? {} : { WMUX_TEST_CDP_PORT: value };
          const expected = value === '1' && suffix !== '' && suffix !== '-portable' && cdpEnabled;
          expect(cdpTestOptIn({ env, suffix, cdpEnabled }), JSON.stringify({ value, suffix, cdpEnabled })).toBe(expected);
        }
      }
    }
  });
});
