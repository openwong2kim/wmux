// @wmux-lane unit
// "win32" here is a stubbed process.platform and the core loader is mocked:
// nothing is loaded from disk, so the OS cannot change the result.
import { afterEach, describe, expect, it, vi } from 'vitest';

// loadNativePipe: the module on Windows only, and a module without the
// pipe listener fails closed there.
const load = vi.fn();
vi.mock('../../shared/nativeTerminalCore', () => ({ loadNativeTerminalCore: (capability: string) => load(capability) }));

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  onPlatform(realPlatform);
  load.mockReset();
});

describe('loadNativePipe', () => {
  it('is null off Windows, without loading anything', async () => {
    const { loadNativePipe } = await import('../nativePipe');
    for (const platform of ['darwin', 'linux'] as const) {
      onPlatform(platform);
      expect(loadNativePipe()).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('asks the core for pipe-listener-v2 on Windows', async () => {
    const { loadNativePipe } = await import('../nativePipe');
    onPlatform('win32');
    const module = { NativePipeListener: class NativePipeListener {}, nativePipeOwnedByUs: () => 'none' };
    load.mockReturnValue(module);
    expect(loadNativePipe()).toBe(module);
    expect(load).toHaveBeenCalledWith('pipe-listener-v2');
  });

  it('throws on Windows when the core lacks the capability', async () => {
    const { loadNativePipe } = await import('../nativePipe');
    onPlatform('win32');
    load.mockImplementation((capability: string) => { throw new Error(`Native terminal core lacks ${capability}`); });
    expect(() => loadNativePipe()).toThrow('lacks pipe-listener-v2');
  });

  it('throws on Windows when the capability is listed but the class is missing', async () => {
    const { loadNativePipe } = await import('../nativePipe');
    onPlatform('win32');
    load.mockReturnValue({});
    expect(() => loadNativePipe()).toThrow('lacks the pipe listener');
  });

  it('throws on Windows when the owner check is missing', async () => {
    const { loadNativePipe } = await import('../nativePipe');
    onPlatform('win32');
    load.mockReturnValue({ NativePipeListener: class NativePipeListener {} });
    expect(() => loadNativePipe()).toThrow('lacks the pipe owner check');
  });

  it('listenNativePipe off Windows without a module throws', async () => {
    const { listenNativePipe } = await import('../nativePipe');
    onPlatform('linux');
    expect(() => listenNativePipe('p', { maxInstances: 1, onConnection: () => undefined })).toThrow('Windows only');
  });
});
