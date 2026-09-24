// @vitest-environment jsdom
//
// #1482 — the close-workspace confirmation stays inside the window: it hangs
// below the close button when there is room and flips above it for rows near
// the bottom, using the real (measured) height rather than the estimate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CloseWorkspaceConfirm, CLOSE_CONFIRM_WIDTH, type CloseConfirmAnchor } from '../WorkspaceItem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEASURED_HEIGHT = 140;
let container: HTMLDivElement;
let root: Root;
let offsetHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  // jsdom has no layout; give the popover a real height so the measure pass
  // has something to correct the opening estimate with.
  offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-workspace-close-confirm') ? MEASURED_HEIGHT : 0;
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
});

function renderAt(anchor: CloseConfirmAnchor, handlers = { onCancel: vi.fn(), onConfirm: vi.fn() }) {
  act(() =>
    root.render(
      createElement(CloseWorkspaceConfirm, {
        anchor,
        title: 'Close “Workspace 16”?',
        terminalCount: 2,
        detail: (n: number) => `${n} terminal(s) will be closed`,
        cancelLabel: 'Cancel',
        confirmLabel: 'Close',
        ...handlers,
      }),
    ),
  );
  const el = container.querySelector('[data-workspace-close-confirm]') as HTMLElement;
  return { el, top: parseFloat(el.style.top), left: parseFloat(el.style.left), handlers };
}

describe('CloseWorkspaceConfirm placement (#1482)', () => {
  it('hangs below the close button when there is room', () => {
    const { top, left } = renderAt({ top: 100, bottom: 124, left: 270, right: 294 });
    expect(top).toBe(128);
    // Right-aligned to the button, so it opens inward over the sidebar.
    expect(left).toBe(294 - CLOSE_CONFIRM_WIDTH);
  });

  it('flips above the close button for a row near the bottom of the window', () => {
    const anchor = { top: 560, bottom: 584, left: 270, right: 294 };
    const { top } = renderAt(anchor);
    expect(top + MEASURED_HEIGHT).toBeLessThanOrEqual(600 - 8);
    expect(top).toBe(anchor.top - MEASURED_HEIGHT - 4);
  });

  it('keeps the Close action reachable and wired', () => {
    const { el, handlers } = renderAt({ top: 560, bottom: 584, left: 270, right: 294 });
    const buttons = Array.from(el.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Close']);
    // The final confirm of a destructive flow is the solid red, not amber.
    expect(buttons[1].className).toContain('ui-btn-danger');
    expect(el.querySelector('.ui-btn-primary')).toBeNull();
    act(() => buttons[1].click());
    expect(handlers.onConfirm).toHaveBeenCalledTimes(1);
    act(() => buttons[0].click());
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('CloseWorkspaceConfirm dismissal when its anchor moves (#1482)', () => {
  it('dismisses on a window resize', () => {
    const { handlers } = renderAt({ top: 100, bottom: 124, left: 270, right: 294 });
    act(() => window.dispatchEvent(new Event('resize')));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('dismisses when something containing it scrolls (the sidebar list)', () => {
    const { handlers } = renderAt({ top: 100, bottom: 124, left: 270, right: 294 });
    act(() => container.dispatchEvent(new Event('scroll')));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores scrolls elsewhere, such as a terminal printing output', () => {
    const { handlers } = renderAt({ top: 100, bottom: 124, left: 270, right: 294 });
    const terminal = document.createElement('div');
    document.body.appendChild(terminal);
    act(() => terminal.dispatchEvent(new Event('scroll')));
    terminal.remove();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });
});
