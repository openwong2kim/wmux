import { describe, expect, it, vi } from 'vitest';
import { QuickLaunchHotkey } from '../hotkey';

function fakeRegistry(taken: Set<string> = new Set()) {
  const held = new Set<string>();
  return {
    held,
    taken,
    register: vi.fn((acc: string) => {
      if (taken.has(acc) || held.has(acc)) return false;
      held.add(acc);
      return true;
    }),
    unregister: vi.fn((acc: string) => {
      held.delete(acc);
    }),
  };
}

describe('QuickLaunchHotkey', () => {
  it('holds the chord while enabled and gives it back when switched off', () => {
    const registry = fakeRegistry();
    const hotkey = new QuickLaunchHotkey({ registry, onPress: () => undefined });
    expect(hotkey.apply(true, 'CommandOrControl+Shift+Space')).toBe(true);
    expect(hotkey.status()).toBe('held');
    expect(hotkey.apply(true, 'CommandOrControl+Shift+Space')).toBe(true);
    expect(registry.register).toHaveBeenCalledTimes(1);
    hotkey.apply(false, 'CommandOrControl+Shift+Space');
    expect(hotkey.status()).toBe('off');
    expect([...registry.held]).toEqual([]);
  });

  it('claims the new chord before releasing the old one, and keeps the old one when the new one is refused', () => {
    const registry = fakeRegistry(new Set(['CommandOrControl+K']));
    const hotkey = new QuickLaunchHotkey({ registry, onPress: () => undefined });
    hotkey.apply(true, 'CommandOrControl+Shift+Space');
    expect(hotkey.apply(true, 'CommandOrControl+K')).toBe(false);
    expect(hotkey.status()).toBe('unavailable');
    expect([...registry.held]).toEqual(['CommandOrControl+Shift+Space']);
    // Rolling back to the held chord clears the failure.
    expect(hotkey.apply(true, 'CommandOrControl+Shift+Space')).toBe(true);
    expect(hotkey.status()).toBe('held');
    expect(hotkey.apply(true, 'CommandOrControl+J')).toBe(true);
    expect([...registry.held]).toEqual(['CommandOrControl+J']);
  });

  it('reports a chord another app holds, and recovers once it is free', () => {
    const registry = fakeRegistry(new Set(['CommandOrControl+Shift+Space']));
    const hotkey = new QuickLaunchHotkey({ registry, onPress: () => undefined });
    expect(hotkey.apply(true, 'CommandOrControl+Shift+Space')).toBe(false);
    expect(hotkey.status()).toBe('unavailable');
    expect(hotkey.failureReason()).toBeTruthy();
    registry.taken.clear();
    expect(hotkey.apply(true, 'CommandOrControl+Shift+Space')).toBe(true);
    expect(hotkey.status()).toBe('held');
  });

  it('treats a throwing register as a refusal and fires onPress from the held chord', () => {
    const onPress = vi.fn();
    const callbacks: Array<() => void> = [];
    const hotkey = new QuickLaunchHotkey({
      registry: {
        register: (acc, cb) => {
          if (acc === 'bad') throw new Error('conversion failed');
          callbacks.push(cb);
          return true;
        },
        unregister: () => undefined,
      },
      onPress,
    });
    expect(hotkey.apply(true, 'bad')).toBe(false);
    expect(hotkey.failureReason()).toBe('conversion failed');
    hotkey.apply(true, 'CommandOrControl+Shift+Space');
    callbacks[0]();
    expect(onPress).toHaveBeenCalledOnce();
  });
});
