// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChromePreset } from '../../../../shared/chromePresets';
import { ChromePresetActionsView } from '../SettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function render(onApply: (preset: ChromePreset) => void): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ChromePresetActionsView onApply={onApply} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function getPresetButton(container: HTMLElement, preset: ChromePreset): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-chrome-preset="${preset}"]`);
  if (!button) throw new Error(`Missing ${preset} preset button`);
  return button;
}

describe('ChromePresetActionsView', () => {
  it('offers one-shot actions without presenting a selected mode', () => {
    const container = render(vi.fn());
    const minimal = getPresetButton(container, 'minimal');
    const standard = getPresetButton(container, 'standard');

    expect(minimal.textContent).toBe('Apply Minimal');
    expect(standard.textContent).toBe('Restore Standard');
    expect(minimal.hasAttribute('aria-pressed')).toBe(false);
    expect(standard.hasAttribute('aria-pressed')).toBe(false);
  });

  it('routes each button to its recipe', () => {
    const onApply = vi.fn();
    const container = render(onApply);

    act(() => getPresetButton(container, 'minimal').click());
    act(() => getPresetButton(container, 'standard').click());

    expect(onApply.mock.calls).toEqual([['minimal'], ['standard']]);
  });
});
