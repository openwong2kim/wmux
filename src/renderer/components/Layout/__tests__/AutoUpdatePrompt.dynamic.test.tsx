// @vitest-environment jsdom
//
// The first-boot auto-update question on ui/Dialog: answered only by its two
// buttons (Escape does nothing), with Enable as the single primary. It appears
// by itself at launch, so it must not take focus from the terminal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AutoUpdatePrompt from '../AutoUpdatePrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AutoUpdatePrompt', () => {
  it('records the choice from its buttons and ignores Escape', () => {
    const onChoose = vi.fn();
    const terminal = document.createElement('textarea');
    document.body.appendChild(terminal);
    terminal.focus();
    act(() => root.render(createElement(AutoUpdatePrompt, { onChoose })));
    const panel = container.querySelector('[data-testid="auto-update-prompt"]') as HTMLElement;
    expect(panel.getAttribute('role')).toBe('alertdialog');
    // Launch-time focus stays in the terminal (the perf bench relies on this too).
    expect(document.activeElement).toBe(terminal);
    terminal.remove();

    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onChoose).not.toHaveBeenCalled();

    const primaries = panel.querySelectorAll('.ui-btn-primary');
    expect(primaries).toHaveLength(1);
    act(() => (primaries[0] as HTMLButtonElement).click());
    expect(onChoose).toHaveBeenLastCalledWith(true);
    act(() => (panel.querySelector('.ui-btn-secondary') as HTMLButtonElement).click());
    expect(onChoose).toHaveBeenLastCalledWith(false);
  });
});
