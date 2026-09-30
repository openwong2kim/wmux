import { describe, it, expect } from 'vitest';
import { createElectronApiShim, ElectronApiDeniedError } from '../electronApiShim';
import { platformFromNavigator, webElectronApiImpl } from '../webElectronApi';

type AnyApi = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('deny-by-default electronAPI shim', () => {
  const make = () => {
    const denied: string[] = [];
    const api = createElectronApiShim({ platform: 'darwin', browser: { getBackendSync: () => undefined } }, (p) => denied.push(p)) as AnyApi;
    return { api, denied };
  };

  it('returns implemented members as-is, nested objects included', () => {
    const { api, denied } = make();
    expect(api.platform).toBe('darwin');
    expect(api.browser.getBackendSync()).toBeUndefined();
    expect(denied).toEqual([]);
  });

  it('denies every unknown member with a rejected promise and records the path', async () => {
    const { api, denied } = make();
    await expect(api.pty.create({})).rejects.toBeInstanceOf(ElectronApiDeniedError);
    await expect(api.shell.openPath('/')).rejects.toThrow('electronAPI.shell.openPath');
    await expect(api.browser.navigate('x')).rejects.toBeInstanceOf(ElectronApiDeniedError);
    await expect(api.accounts.list()).rejects.toBeInstanceOf(ElectronApiDeniedError);
    expect(denied).toEqual(['pty.create', 'shell.openPath', 'browser.navigate', 'accounts.list']);
  });

  it('is never a thenable and cannot be written to', () => {
    const { api } = make();
    expect(api.then).toBeUndefined();
    expect(api.pty.then).toBeUndefined();
    expect(() => { api.pty = {}; }).toThrow(TypeError);
    expect(() => { api.platform = 'win32'; }).toThrow(TypeError);
  });

  it('derives the platform from the browser', () => {
    expect(platformFromNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe('darwin');
    expect(platformFromNavigator({ userAgent: 'x', platform: 'Win32' })).toBe('win32');
    expect(platformFromNavigator({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
    expect(Object.keys(webElectronApiImpl({ userAgent: 'x', language: 'en' })).sort())
      .toEqual(['browser', 'platform', 'systemLocale', 'windowsBuildNumber']);
  });
});
