import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineDeferral } from '../engineDeferral';

function setup() {
  const state = { composing: false, dragging: false };
  let retry: (() => void) | null = null;
  const apply = vi.fn();
  const deferral = createEngineDeferral({
    isComposing: () => state.composing,
    isDragging: () => state.dragging,
    subscribeUnblock: (r) => { retry = r; return () => { retry = null; }; },
    apply,
  });
  return { state, apply, deferral, unblock: () => retry?.(), subscribed: () => retry !== null };
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('engine swap deferral', () => {
  it('applies at once when nothing blocks it', () => {
    const s = setup();
    s.deferral.request();
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(s.subscribed()).toBe(false);
  });

  it('waits out an IME composition and applies on compositionend', () => {
    const s = setup();
    s.state.composing = true;
    s.deferral.request();
    expect(s.apply).not.toHaveBeenCalled();
    s.unblock(); // an unrelated event while still composing
    expect(s.apply).not.toHaveBeenCalled();
    s.state.composing = false;
    s.unblock(); // compositionend
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(s.subscribed()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(s.apply).toHaveBeenCalledTimes(1);
  });

  it('waits out a mouse drag, and forces the swap after the cap', () => {
    const s = setup();
    s.state.dragging = true;
    s.deferral.request();
    s.deferral.request(); // a second request joins the wait
    vi.advanceTimersByTime(2999);
    expect(s.apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(s.subscribed()).toBe(false);
  });

  it('cancel drops a waiting swap', () => {
    const s = setup();
    s.state.composing = true;
    s.deferral.request();
    s.deferral.cancel();
    vi.advanceTimersByTime(5000);
    expect(s.apply).not.toHaveBeenCalled();
  });
});
