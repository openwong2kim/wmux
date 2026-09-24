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

// A segmented control: one radio per route, named by its label (the stub t
// returns the key, so the label is the i18n key).
const LABEL: Record<ImagePasteMode, string> = {
  auto: 'settings.imagePasteAuto',
  native: 'settings.imagePasteNative',
  path: 'settings.imagePastePath',
};

function button(container: HTMLElement, mode: ImagePasteMode): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    .find((b) => b.textContent === LABEL[mode]);
  if (!el) throw new Error(`Missing ${mode} button`);
  return el;
}

describe('ImagePasteModeView (#1196)', () => {
  it('offers all three routes and marks the active one', () => {
    const container = render('auto', vi.fn());

    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(button(container, 'auto').getAttribute('aria-checked')).toBe('true');
    expect(button(container, 'native').getAttribute('aria-checked')).toBe('false');
    expect(button(container, 'path').getAttribute('aria-checked')).toBe('false');
  });

  it('reports the picked mode', () => {
    const onChange = vi.fn();
    const container = render('auto', onChange);

    act(() => button(container, 'native').click());
    act(() => button(container, 'path').click());

    expect(onChange.mock.calls).toEqual([['native'], ['path']]);
  });
});
