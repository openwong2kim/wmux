// @vitest-environment jsdom
// Glance board (2026-09-25): no reshuffle under the pointer — a re-sort
// applies after the settle, or at once when the pointer leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSettledOrder } from '../useSettledOrder';

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useSettledOrder<{ id: string }>>;

function Probe({ desired }: { desired: { id: string }[] }) {
  api = useSettledOrder(desired, true, 3000, 10_000);
  return null;
}
const render = (order: string[]) => act(() => root.render(<Probe desired={order.map((id) => ({ id }))} />));
const shown = () => api.ordered.map((w) => w.id);

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useSettledOrder', () => {
  it('applies a re-sort only after the settle', () => {
    render(['a', 'b', 'c']);
    render(['c', 'a', 'b']);
    expect(shown()).toEqual(['a', 'b', 'c']);
    act(() => { vi.advanceTimersByTime(2999); });
    expect(shown()).toEqual(['a', 'b', 'c']);
    act(() => { vi.advanceTimersByTime(1); });
    expect(shown()).toEqual(['c', 'a', 'b']);
  });

  it('holds the order while the pointer is inside, and applies it on leave', () => {
    render(['a', 'b', 'c']);
    act(() => api.onPointerEnter());
    render(['c', 'a', 'b']);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(shown()).toEqual(['a', 'b', 'c']);
    act(() => api.onPointerLeave());
    expect(shown()).toEqual(['c', 'a', 'b']);
  });

  it('restarts the settle on every change', () => {
    render(['a', 'b']);
    render(['b', 'a']);
    act(() => { vi.advanceTimersByTime(2000); });
    render(['b', 'a', 'x']);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(shown()).toEqual(['a', 'b', 'x']);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown()).toEqual(['b', 'a', 'x']);
  });

  // Review #7 — changes that never stop still re-sort after the max wait.
  it('applies after the max wait under continuous changes', () => {
    render(['a', 'b', 'c']);
    const orders = [['c', 'a', 'b'], ['b', 'c', 'a'], ['c', 'b', 'a'], ['b', 'a', 'c'], ['c', 'a', 'b']];
    for (const order of orders) {
      render(order);
      act(() => { vi.advanceTimersByTime(2000); });
    }
    expect(shown()).toEqual(['c', 'a', 'b']);
  });

  // Review #8 — keyboard focus inside the list holds the order too.
  it('holds while focus is inside, and applies when focus leaves the list', () => {
    render(['a', 'b']);
    act(() => api.onFocusCapture());
    render(['b', 'a']);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(shown()).toEqual(['a', 'b']);
    const list = document.createElement('div');
    act(() => api.onBlurCapture({ relatedTarget: null, currentTarget: list } as unknown as React.FocusEvent<HTMLElement>));
    expect(shown()).toEqual(['b', 'a']);
  });
});
