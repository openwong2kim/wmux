import { describe, expect, it } from 'vitest';
import {
  admissionRefusal,
  BROKER_MAX_NEW_CONNECTIONS_PER_SEC,
  brokerLimitsFromEnv,
  ConnectionRate,
  NO_BROKER_LIMITS,
  parseBrokerLimits,
} from '../brokerLimits';

describe('parseBrokerLimits', () => {
  it('no mcp.broker, or no keys: no limit at all (the default)', () => {
    expect(parseBrokerLimits(undefined)).toEqual({ limits: NO_BROKER_LIMITS, ignored: [] });
    expect(parseBrokerLimits(null)).toEqual({ limits: NO_BROKER_LIMITS, ignored: [] });
    expect(parseBrokerLimits({})).toEqual({ limits: NO_BROKER_LIMITS, ignored: [] });
  });

  it('positive integers set a limit; 0 and null set none', () => {
    expect(parseBrokerLimits({ maxSessions: 10, maxRssMb: 512, maxBrowserReplRunners: 40 }).limits)
      .toEqual({ maxSessions: 10, maxRssMb: 512, maxBrowserReplRunners: 40 });
    expect(parseBrokerLimits({ maxSessions: 0, maxRssMb: null }).limits).toEqual(NO_BROKER_LIMITS);
  });

  it('anything else is ignored and named, never turned into a limit', () => {
    expect(parseBrokerLimits({ maxSessions: -1, maxRssMb: 1.5, maxBrowserReplRunners: '8' })).toEqual({
      limits: NO_BROKER_LIMITS,
      ignored: ['mcp.broker.maxSessions', 'mcp.broker.maxRssMb', 'mcp.broker.maxBrowserReplRunners'],
    });
    expect(parseBrokerLimits('10')).toEqual({ limits: NO_BROKER_LIMITS, ignored: ['mcp.broker'] });
    expect(parseBrokerLimits([10])).toEqual({ limits: NO_BROKER_LIMITS, ignored: ['mcp.broker'] });
  });
});

describe('brokerLimitsFromEnv', () => {
  it('reads what the app passed, and no limit for an absent or unreadable value', () => {
    expect(brokerLimitsFromEnv('{"maxSessions":3,"maxRssMb":null,"maxBrowserReplRunners":null}'))
      .toEqual({ maxSessions: 3, maxRssMb: null, maxBrowserReplRunners: null });
    expect(brokerLimitsFromEnv(undefined)).toEqual(NO_BROKER_LIMITS);
    expect(brokerLimitsFromEnv('not json')).toEqual(NO_BROKER_LIMITS);
  });
});

describe('admissionRefusal', () => {
  const MiB = 1024 * 1024;

  it('with no limit, admits any number of sessions at any size', () => {
    expect(admissionRefusal(NO_BROKER_LIMITS, { sessions: 10_000, rssBytes: 64_000 * MiB })).toBeNull();
  });

  it('maxSessions: admits below it and refuses at it, naming the setting', () => {
    const limits = { ...NO_BROKER_LIMITS, maxSessions: 10 };
    expect(admissionRefusal(limits, { sessions: 9, rssBytes: 0 })).toBeNull();
    expect(admissionRefusal(limits, { sessions: 10, rssBytes: 0 })).toBe('mcp.broker.maxSessions (10) reached');
  });

  it('maxRssMb: admits below it and refuses at it, naming the setting and the size', () => {
    const limits = { ...NO_BROKER_LIMITS, maxRssMb: 256 };
    expect(admissionRefusal(limits, { sessions: 0, rssBytes: 255 * MiB })).toBeNull();
    expect(admissionRefusal(limits, { sessions: 0, rssBytes: 300 * MiB }))
      .toBe('mcp.broker.maxRssMb (256) reached: the broker uses 300 MiB');
  });
});

describe('ConnectionRate', () => {
  it('never refuses 20 agents starting at the same moment', () => {
    const rate = new ConnectionRate(BROKER_MAX_NEW_CONNECTIONS_PER_SEC, () => 1000);
    expect(Array.from({ length: 20 }, () => rate.admit()).every(Boolean)).toBe(true);
  });

  it(`takes ${BROKER_MAX_NEW_CONNECTIONS_PER_SEC} in one second, refuses the next, and starts over after it`, () => {
    let now = 5000;
    const rate = new ConnectionRate(BROKER_MAX_NEW_CONNECTIONS_PER_SEC, () => now);
    for (let i = 0; i < BROKER_MAX_NEW_CONNECTIONS_PER_SEC; i++) expect(rate.admit()).toBe(true);
    expect(rate.admit()).toBe(false);
    now += 999;
    expect(rate.admit()).toBe(false);
    now += 1;
    expect(rate.admit()).toBe(true);
  });

  it('matches the app pipe and stays well above a 20-agent start', () => {
    expect(BROKER_MAX_NEW_CONNECTIONS_PER_SEC).toBe(120);
    expect(BROKER_MAX_NEW_CONNECTIONS_PER_SEC).toBeGreaterThanOrEqual(20 * 5);
  });
});
