// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pageListener: added to the page when a terminal opens, as wongtty's first
// terminal does (listen_page).
const opened = vi.hoisted(() => ({ throwOnOpen: true, disposed: 0, created: 0, pageListener: null as null | (() => void) }));

// Each call is a fresh evaluation of the package, as the real factory's is.
vi.mock('../factory', () => ({
  createWongtty: () => {
    opened.created++;
    return {
      init: vi.fn(async () => undefined),
      Terminal: class {
        open() {
          if (opened.pageListener) document.addEventListener('wmux-page', opened.pageListener);
          if (opened.throwOnOpen) throw new Error('WebGL2 is not available');
        }
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

afterEach(() => { vi.resetModules(); vi.useRealTimers(); opened.disposed = 0; opened.created = 0; opened.pageListener = null; });

const pageEvent = () => document.dispatchEvent(new Event('wmux-page'));

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

  it('removes what a failing probe added to the page, and puts addEventListener back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const add = EventTarget.prototype.addEventListener;
    const heard = vi.fn();
    opened.pageListener = heard;
    opened.throwOnOpen = true;
    const load = await import('../load');
    expect(await load.preloadWongtty()).toBeNull();
    expect(EventTarget.prototype.addEventListener).toBe(add);
    pageEvent();
    expect(heard).not.toHaveBeenCalled();
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

  it('lets go of a module that finished loading after the switch went off', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    opened.throwOnOpen = false;
    const load = await import('../load');
    const loading = load.preloadWongtty();
    load.releaseWongttyWhenIdle();
    expect(await loading).not.toBeNull();
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBeNull();
  });

  it('removes the listeners the module added to the page once it is let go', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const add = EventTarget.prototype.addEventListener;
    const heard = vi.fn();
    opened.pageListener = heard;
    opened.throwOnOpen = false;
    const load = await import('../load');
    expect(await load.preloadWongtty()).not.toBeNull();
    expect(EventTarget.prototype.addEventListener).toBe(add);
    pageEvent();
    expect(heard).toHaveBeenCalledTimes(1);
    load.releaseWongttyWhenIdle();
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBeNull();
    pageEvent();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keeps the module while a swap holds it, and lets go once the hold ends', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    opened.throwOnOpen = false;
    const load = await import('../load');
    const mod = await load.preloadWongtty();
    const unhold = load.holdWongtty();
    const other = load.holdWongtty();
    load.releaseWongttyWhenIdle();
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBe(mod);
    unhold();
    unhold(); // twice counts once
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBe(mod);
    other();
    vi.runAllTimers();
    expect(load.loadedWongtty()).toBeNull();
  });
});
