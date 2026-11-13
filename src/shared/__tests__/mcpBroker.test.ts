// @wmux-lane unit
// Pure functions of the platform name passed in: the OS running the test cannot change a result.
import { describe, expect, it } from 'vitest';
import { BROKER_DEFAULT_ON, brokerDefault, brokerFlag } from '../mcpBroker';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
const VALUES: (string | undefined)[] = [undefined, '0', '1'];

describe('brokerDefault with the shipped BROKER_DEFAULT_ON', () => {
  // Changing the default is a separate, deliberate change: it edits this test.
  it('is empty: unset means off on every platform', () => {
    expect(BROKER_DEFAULT_ON).toEqual([]);
  });

  // Today's behaviour, before shared/mcpBroker.ts: only '1' turns the broker on.
  const today = (value: string | undefined) => value === '1';
  for (const platform of PLATFORMS) {
    for (const value of VALUES) {
      it(`${platform}, WMUX_MCP_BROKER=${String(value)} → ${today(value) ? 'on' : 'off'} (today's behaviour)`, () => {
        expect(brokerDefault(platform, value)).toBe(today(value));
      });
    }
  }

  it('any other value counts as unset (off), as before', () => {
    for (const platform of PLATFORMS) {
      for (const value of ['', 'true', 'on', 'yes', ' 1', '01']) {
        expect(brokerDefault(platform, value), `${platform} ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });
});

describe('brokerDefault with a platform default passed in', () => {
  // The rows a later default would give, passed explicitly so they never reach
  // the shipped rule.
  const later: readonly NodeJS.Platform[] = ['darwin', 'linux'];
  const rows: [NodeJS.Platform, string | undefined, boolean][] = [
    ['darwin', undefined, true],
    ['darwin', '0', false],
    ['darwin', '1', true],
    ['linux', undefined, true],
    ['linux', '0', false],
    ['linux', '1', true],
    ['win32', undefined, false],
    ['win32', '0', false],
    ['win32', '1', true],
  ];
  for (const [platform, value, on] of rows) {
    it(`${platform}, WMUX_MCP_BROKER=${String(value)} → ${on ? 'on' : 'off'}`, () => {
      expect(brokerDefault(platform, value, later)).toBe(on);
    });
  }
});

describe('brokerFlag', () => {
  it('reads 1 as on, 0 as off and anything else as unset', () => {
    expect(brokerFlag('1')).toBe('on');
    expect(brokerFlag('0')).toBe('off');
    expect(brokerFlag(undefined)).toBe('unset');
    expect(brokerFlag('true')).toBe('unset');
  });
});
