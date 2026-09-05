// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImagePasteMode } from '../../../../shared/imagePaste';
import { ImagePasteModeView } from '../SettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function render(value: ImagePasteMode, onChange: (mode: ImagePasteMode) => void): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ImagePasteModeView value={value} onChange={onChange} t={(k) => k} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function button(container: HTMLElement, mode: ImagePasteMode): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-image-paste-mode="${mode}"]`);
  if (!el) throw new Error(`Missing ${mode} button`);
  return el;
}

describe('ImagePasteModeView (#1196)', () => {
  it('offers all three routes and marks the active one', () => {
    const container = render('auto', vi.fn());

    expect(button(container, 'auto').getAttribute('aria-pressed')).toBe('true');
    expect(button(container, 'native').getAttribute('aria-pressed')).toBe('false');
    expect(button(container, 'path').getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the picked mode', () => {
    const onChange = vi.fn();
    const container = render('auto', onChange);

    act(() => button(container, 'native').click());
    act(() => button(container, 'path').click());

    expect(onChange.mock.calls).toEqual([['native'], ['path']]);
  });
});
