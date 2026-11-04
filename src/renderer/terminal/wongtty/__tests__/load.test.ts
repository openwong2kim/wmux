// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ throwOnOpen: true, disposed: 0, created: 0 }));

// Each call is a fresh evaluation of the package, as the real factory's is.
vi.mock('../factory', () => ({
  createWongtty: () => {
    opened.created++;
    return {
      init: vi.fn(async () => undefined),
      Terminal: class {
        open() { if (opened.throwOnOpen) throw new Error('WebGL2 is not available'); }
        dispose() { opened.disposed++; }
      },
    };
  },
}));

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { settings: { getWongttyWasm: vi.fn(async () => ({ engine: new Uint8Array(), frontEnd: new Uint8Array() })) } },
  });
});

afterEach(() => { vi.resetModules(); vi.useRealTimers(); opened.disposed = 0; opened.created = 0; });

describe('wongtty load probe', () => {
  it('returns null and records why when a probe terminal cannot open', async () => {
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

describe('wongtty release', () => {
  it('lets go of the module once the last terminal is disposed, and the next load starts afresh', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    opened.throwOnOpen = false;
    const load = await import('../load');
    const mod = await load.preloadWongtty();
    expect(mod).not.toBeNull();
    const a = new mod!.Terminal();
    const b = new mod!.Terminal();
    expect(load.isWongttyTerminal(a)).toBe(true);

    // Asked while terminals are still alive: kept until the last one goes.
    load.releaseWongttyWhenIdle();
    a.dispose();
    a.dispose(); // twice counts once
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBe(mod);
    b.dispose();
    // Not in the same task: the teardown that disposed it may still ask.
    expect(load.isWongttyTerminal(b)).toBe(true);
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBeNull();
    expect(load.isWongttyTerminal(b)).toBe(false);

    const again = await load.preloadWongtty();
    expect(again).not.toBeNull();
    expect(again).not.toBe(mod);
    expect(opened.created).toBe(2);
  });

  it('keeps the module when the switch comes back on before the last terminal goes', async () => {
    vi.useFakeTimers();
    opened.throwOnOpen = false;
    const load = await import('../load');
    const mod = await load.preloadWongtty();
    const a = new mod!.Terminal();
    load.releaseWongttyWhenIdle();
    expect(await load.preloadWongtty()).toBe(mod);
    a.dispose();
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBe(mod);
    expect(opened.created).toBe(1);
  });
});
