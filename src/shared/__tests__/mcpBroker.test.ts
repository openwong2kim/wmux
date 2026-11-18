// @wmux-lane unit
// Pure functions of the platform name passed in: the OS running the test cannot change a result.
import { describe, expect, it } from 'vitest';
import { BROKER_DEFAULT_ON, brokerDecision, brokerDefault, brokerFlag, brokerHostsSessions, brokerMayRun, isBrokerSetting, type BrokerSetting } from '../mcpBroker';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
const VALUES: (string | undefined)[] = [undefined, '0', '1'];

describe('brokerDefault with the shipped BROKER_DEFAULT_ON', () => {
  // Changing the default is a separate, deliberate change: it edits this test.
  it('is macOS and Linux: unset means on there, off on Windows', () => {
    expect(BROKER_DEFAULT_ON).toEqual(['darwin', 'linux']);
  });

  // '1' and '0' win everywhere; unset follows the platform.
  const shipped = (platform: NodeJS.Platform, value: string | undefined) =>
    value === '1' || (value !== '0' && BROKER_DEFAULT_ON.includes(platform));
  for (const platform of PLATFORMS) {
    for (const value of VALUES) {
      it(`${platform}, WMUX_MCP_BROKER=${String(value)} → ${shipped(platform, value) ? 'on' : 'off'}`, () => {
        expect(brokerDefault(platform, value)).toBe(shipped(platform, value));
      });
    }
  }

  it('an off spelling turns it off everywhere: unset meaning on must not swallow it', () => {
    for (const platform of PLATFORMS) {
      for (const value of ['0', 'false', 'FALSE', 'off', 'Off', 'no', ' 0 ', ' false']) {
        expect(brokerDefault(platform, value), `${platform} ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it('any other value counts as unset, so it follows the platform', () => {
    for (const platform of PLATFORMS) {
      for (const value of ['', 'true', 'on', 'yes', ' 1', '01']) {
        expect(brokerDefault(platform, value), `${platform} ${JSON.stringify(value)}`).toBe(BROKER_DEFAULT_ON.includes(platform));
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
  it('reads 1 as on, 0 (or false/off/no) as off and anything else as unset', () => {
    expect(brokerFlag('1')).toBe('on');
    expect(brokerFlag('0')).toBe('off');
    expect(brokerFlag(' False ')).toBe('off');
    expect(brokerFlag('')).toBe('unset');
    expect(brokerFlag(undefined)).toBe('unset');
    expect(brokerFlag('true')).toBe('unset');
  });
});

describe('brokerDecision: environment, then Settings, then the platform', () => {
  const SETTINGS: BrokerSetting[] = ['default', 'on', 'off'];
  for (const platform of PLATFORMS) {
    for (const value of VALUES) {
      for (const setting of SETTINGS) {
        const want = value === '1' ? { on: true, source: 'env' }
          : value === '0' ? { on: false, source: 'env' }
            : setting === 'on' ? { on: true, source: 'setting' }
              : setting === 'off' ? { on: false, source: 'setting' }
                : { on: BROKER_DEFAULT_ON.includes(platform), source: 'default' };
        it(`${platform}, WMUX_MCP_BROKER=${String(value)}, Settings ${setting} → ${want.on ? 'on' : 'off'} by ${want.source}`, () => {
          expect(brokerDecision(platform, value, setting)).toEqual(want);
        });
      }
    }
  }

  it('Default follows the platform default, and Off in Settings turns it off', () => {
    expect(brokerDecision('darwin', undefined, 'default', ['darwin'])).toEqual({ on: true, source: 'default' });
    expect(brokerDecision('darwin', undefined, 'off', ['darwin'])).toEqual({ on: false, source: 'setting' });
    expect(brokerDecision('linux', undefined, 'off')).toEqual({ on: false, source: 'setting' });
    expect(brokerDecision('win32', undefined, 'default', [])).toEqual({ on: false, source: 'default' });
  });
});

describe('brokerMayRun (wmux mcp register probes only when this is true)', () => {
  it('is false only when the environment or Settings turns it off', () => {
    expect(brokerMayRun('darwin', '0', 'on')).toBe(false);
    expect(brokerMayRun('darwin', undefined, 'off')).toBe(false);
    expect(brokerMayRun('darwin', '1', 'off')).toBe(true);
    expect(brokerMayRun('darwin', undefined, 'on')).toBe(true);
    // The app may have WMUX_MCP_BROKER=1 that this shell does not see.
    expect(brokerMayRun('win32', undefined, 'default')).toBe(true);
  });
});

describe('isBrokerSetting', () => {
  it('the default is on exactly where the broker can host sessions', () => {
    for (const platform of PLATFORMS) expect(BROKER_DEFAULT_ON.includes(platform)).toBe(brokerHostsSessions(platform));
  });

  it('takes default, on and off only', () => {
    for (const v of ['default', 'on', 'off']) expect(isBrokerSetting(v)).toBe(true);
    for (const v of ['', 'ON', '1', 1, null, undefined, {}]) expect(isBrokerSetting(v)).toBe(false);
  });
});
