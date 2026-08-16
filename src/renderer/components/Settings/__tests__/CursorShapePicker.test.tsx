// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorShapePicker } from '../CursorShapePicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function render(value: 'block' | 'bar' | 'underline', onChange = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const t = (key: string) => key;
  act(() => root.render(<CursorShapePicker value={value} onChange={onChange} t={t} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, onChange };
}

describe('CursorShapePicker', () => {
  it('marks the current shape as the checked radio', () => {
    const { container } = render('block');
    const block = container.querySelector<HTMLButtonElement>('[data-cursor-style="block"]');
    const bar = container.querySelector<HTMLButtonElement>('[data-cursor-style="bar"]');
    expect(block?.getAttribute('aria-checked')).toBe('true');
    expect(bar?.getAttribute('aria-checked')).toBe('false');
  });

  it('reports the clicked shape', () => {
    const { container, onChange } = render('block');
    act(() => container.querySelector<HTMLButtonElement>('[data-cursor-style="bar"]')?.click());
    expect(onChange).toHaveBeenCalledWith('bar');
  });
});
