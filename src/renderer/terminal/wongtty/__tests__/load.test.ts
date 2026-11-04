// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ throwOnOpen: true, disposed: 0 }));

vi.mock('wongtty/xterm', () => ({
  init: vi.fn(async () => undefined),
  Terminal: class {
    open() { if (opened.throwOnOpen) throw new Error('WebGL2 is not available'); }
    dispose() { opened.disposed++; }
  },
}));

afterEach(() => { vi.resetModules(); opened.disposed = 0; });

describe('wongtty load probe', () => {
  it('returns null and records why when a probe terminal cannot open', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { settings: { getWongttyWasm: vi.fn(async () => ({ engine: new Uint8Array(), frontEnd: new Uint8Array() })) } },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = await import('../load');
    opened.throwOnOpen = true;
    expect(await load.preloadWongtty()).toBeNull();
    expect(load.wongttyLoadFailure()).toBe('WebGL2 is not available');
    expect(load.loadedWongtty()).toBeNull();
    // The probe terminal and its element are gone either way.
    expect(opened.disposed).toBe(1);
    expect(document.body.children).toHaveLength(0);

    // The next call retries, and a probe that opens loads the module.
    opened.throwOnOpen = false;
    expect(await load.preloadWongtty()).not.toBeNull();
    expect(load.wongttyLoadFailure()).toBeNull();
    expect(load.loadedWongtty()).not.toBeNull();
  });
});
