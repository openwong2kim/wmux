import { describe, expect, it, vi } from 'vitest';
import { StopKey, type ShortcutRegistry } from '../stopKey';

const ACCEL = 'CommandOrControl+Alt+Shift+Escape';

function registry(opts: { free?: boolean; throws?: boolean } = {}) {
  let callback: (() => void) | null = null;
  const reg = {
    free: opts.free ?? true,
    register: vi.fn((_accel: string, cb: () => void) => {
      if (opts.throws) throw new Error('not ready');
      if (!reg.free) return false;
      callback = cb;
      return true;
    }),
    unregister: vi.fn(() => { callback = null; }),
    press: () => callback?.(),
  };
  return reg satisfies ShortcutRegistry & { press: () => void };
}

describe('StopKey', () => {
  it('holds the chord once and presses through to the stop', () => {
    const reg = registry();
    const onPress = vi.fn();
    const key = new StopKey({ registry: reg, accelerator: ACCEL, onPress });
    expect(key.status()).toBe('off');
    expect(key.arm()).toBe(true);
    expect(key.arm()).toBe(true);
    expect(reg.register).toHaveBeenCalledTimes(1);
    expect(key.status()).toBe('held');
    reg.press();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable when another app owns the chord, and recovers once it is free', () => {
    const reg = registry({ free: false });
    const log = vi.fn();
    const key = new StopKey({ registry: reg, accelerator: ACCEL, onPress: vi.fn(), log });
    expect(key.arm()).toBe(false);
    expect(key.status()).toBe('unavailable');
    expect(log).toHaveBeenCalledTimes(1);
    expect(key.arm()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1); // logged once, not on every call
    reg.free = true;
    expect(key.arm()).toBe(true);
    expect(key.status()).toBe('held');
  });

  it('treats a registration that throws as unavailable', () => {
    const key = new StopKey({ registry: registry({ throws: true }), accelerator: ACCEL, onPress: vi.fn() });
    expect(key.arm()).toBe(false);
    expect(key.status()).toBe('unavailable');
  });

  it('gives the chord back on release, and only if it held it', () => {
    const reg = registry();
    const key = new StopKey({ registry: reg, accelerator: ACCEL, onPress: vi.fn() });
    key.release();
    expect(reg.unregister).not.toHaveBeenCalled();
    key.arm();
    key.release();
    expect(reg.unregister).toHaveBeenCalledWith(ACCEL);
    expect(key.status()).toBe('off');
    key.release();
    expect(reg.unregister).toHaveBeenCalledTimes(1);
  });

  it('release clears an unavailable state (computer use turned off)', () => {
    const key = new StopKey({ registry: registry({ free: false }), accelerator: ACCEL, onPress: vi.fn() });
    key.arm();
    key.release();
    expect(key.status()).toBe('off');
  });
});
