import { describe, expect, it } from 'vitest';
import { resolveCdpRemoteDebuggingConfig } from '../cdpConfig';

describe('resolveCdpRemoteDebuggingConfig', () => {
  it('disables CDP by default in packaged builds', () => {
    expect(resolveCdpRemoteDebuggingConfig({ env: {}, isPackaged: true })).toMatchObject({
      enabled: false,
      port: 0,
    });
  });

  it('allows an explicit CDP opt-in for packaged builds on a randomized loopback port', () => {
    expect(
      resolveCdpRemoteDebuggingConfig({
        env: { WMUX_ENABLE_CDP: 'true' },
        isPackaged: true,
        randomInt: () => 42,
      }),
    ).toEqual({ enabled: true, port: 18842 });
  });

  it('honors an explicit CDP port only after CDP is enabled', () => {
    expect(
      resolveCdpRemoteDebuggingConfig({
        env: { WMUX_ENABLE_CDP: 'true', WMUX_CDP_PORT: '18850' },
        isPackaged: true,
      }),
    ).toEqual({ enabled: true, port: 18850 });
  });

  it('lets WMUX_DISABLE_CDP override all other settings', () => {
    expect(
      resolveCdpRemoteDebuggingConfig({
        env: { WMUX_DISABLE_CDP: 'true', WMUX_ENABLE_CDP: 'true', WMUX_CDP_PORT: '18850' },
        isPackaged: true,
      }),
    ).toMatchObject({ enabled: false, port: 0 });
  });

  it('keeps development builds debuggable without exposing a fixed port', () => {
    expect(
      resolveCdpRemoteDebuggingConfig({
        env: {},
        isPackaged: false,
        randomInt: () => 7,
      }),
    ).toEqual({ enabled: true, port: 18807 });
  });

  it('rejects out-of-range explicit ports', () => {
    expect(() =>
      resolveCdpRemoteDebuggingConfig({
        env: { WMUX_ENABLE_CDP: 'true', WMUX_CDP_PORT: '18799' },
        isPackaged: true,
      }),
    ).toThrow('WMUX_CDP_PORT must be an integer in the range 18800-18899');
  });
});
