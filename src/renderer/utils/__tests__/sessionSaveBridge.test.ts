import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerSessionSaver, saveSessionNow } from '../sessionSaveBridge';

afterEach(() => registerSessionSaver(null));

describe('sessionSaveBridge (axis A: event-driven immediate persistence)', () => {
  it('saveSessionNow is a no-op before any saver is registered', () => {
    registerSessionSaver(null);
    expect(() => saveSessionNow()).not.toThrow();
  });

  it('calls the registered saver once per saveSessionNow', () => {
    const saver = vi.fn();
    registerSessionSaver(saver);
    saveSessionNow();
    saveSessionNow();
    expect(saver).toHaveBeenCalledTimes(2);
  });

  it('swallows saver errors — never throws to the caller (teardown site safety)', () => {
    registerSessionSaver(() => { throw new Error('boom'); });
    expect(() => saveSessionNow()).not.toThrow();
  });

  it('unregister (null) restores the no-op', () => {
    const saver = vi.fn();
    registerSessionSaver(saver);
    registerSessionSaver(null);
    saveSessionNow();
    expect(saver).not.toHaveBeenCalled();
  });

  it('a newer registration replaces the previous saver', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerSessionSaver(first);
    registerSessionSaver(second);
    saveSessionNow();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
