// @wmux-lane unit
// 'win32' below is only a stubbed process.platform; nothing reaches the OS.
// #2964: the runtime gate reads the platform, app.isPackaged and the data
// suffix, and says so once in the log when it turns toasts off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }));
vi.mock('electron', () => ({ app: electron.app }));

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

describe('osToastsAllowed', () => {
  let savedSuffix: string | undefined;

  beforeEach(() => {
    savedSuffix = process.env.WMUX_DATA_SUFFIX;
    electron.app.isPackaged = true;
    setPlatform('win32');
    vi.resetModules();
  });

  afterEach(() => {
    if (savedSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = savedSuffix;
    setPlatform(realPlatform);
    vi.restoreAllMocks();
  });

  it('the installed app on Windows (packaged, no suffix) may raise toasts', async () => {
    delete process.env.WMUX_DATA_SUFFIX;
    const { osToastsAllowed } = await import('../osToastGate');
    expect(osToastsAllowed()).toBe(true);
  });

  it('an isolated packaged copy on Windows may not, and the log says why once', async () => {
    process.env.WMUX_DATA_SUFFIX = '-verify-x';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { osToastsAllowed } = await import('../osToastGate');
    expect(osToastsAllowed()).toBe(false);
    expect(osToastsAllowed()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('#2964');
  });

  it('an unpackaged dev build with its -dev suffix keeps toasts', async () => {
    electron.app.isPackaged = false;
    process.env.WMUX_DATA_SUFFIX = '-dev';
    const { osToastsAllowed } = await import('../osToastGate');
    expect(osToastsAllowed()).toBe(true);
  });
});
