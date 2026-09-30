import { describe, it, expect, vi } from 'vitest';
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
      .toEqual(['browser', 'daemon', 'events', 'platform', 'pty', 'systemLocale', 'windowsBuildNumber']);
  });

  it('returns the same node for the same path', () => {
    const { api } = make();
    expect(api.browser).toBe(api.browser);
    expect(api.pty).toBe(api.pty);
    expect(api.pty.create).toBe(api.pty.create);
  });

  it('a fire-and-forget denied call is not an unhandled rejection', async () => {
    const { api, denied } = make();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    void api.shell.openExternal('https://example.com');
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(denied).toEqual(['shell.openExternal']);
  });

  it('pty: forwards the stream/input members to the bridge, denies create/dispose/promote/resize', async () => {
    const denied: string[] = [];
    const holder: { bridge?: Record<string, (...args: unknown[]) => unknown> } = {};
    const api = createElectronApiShim(webElectronApiImpl({ userAgent: 'x', language: 'en' }, () => holder.bridge), (p) => denied.push(p)) as AnyApi;
    // Before the bundle publishes the bridge: subscriptions are inert, calls reject (handled).
    expect(typeof api.pty.onData(() => undefined)).toBe('function');
    await expect(api.pty.list()).rejects.toThrow('not ready');
    const write = vi.fn(async () => undefined);
    holder.bridge = { write, list: async () => [{ id: 'a' }] };
    await api.pty.write('a', 'x');
    expect(write).toHaveBeenCalledWith('a', 'x');
    expect(await api.pty.list()).toEqual([{ id: 'a' }]);
    expect(typeof api.daemon.onConnected(() => undefined)).toBe('function');
    for (const m of ['create', 'dispose', 'promote', 'resize', 'cancelCreate']) {
      await expect(api.pty[m]('a')).rejects.toBeInstanceOf(ElectronApiDeniedError);
    }
    expect(denied).toEqual(['pty.create', 'pty.dispose', 'pty.promote', 'pty.resize', 'pty.cancelCreate']);
  });

  it('swallows the desktop EventBus announcements a tap makes, sending nothing', () => {
    const denied: string[] = [];
    const api = createElectronApiShim(webElectronApiImpl({ userAgent: 'x', language: 'en' }), (p) => denied.push(p)) as AnyApi;
    expect(api.events.publish({ type: 'pane.focused', workspaceId: 'w' })).toBeUndefined();
    expect(denied).toEqual([]);
  });
});
