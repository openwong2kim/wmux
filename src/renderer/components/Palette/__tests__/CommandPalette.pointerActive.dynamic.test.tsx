// @vitest-environment jsdom
//
// One selected look: moving the pointer over a row makes it the active row,
// so a hovered row and a keyboard-active row are never highlighted at once.
// Arrow keys still move the selection from wherever it is.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import CommandPalette from '../CommandPalette';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom has no layout to scroll */
  };
  // The palette lists plugin commands; an empty plugin host is enough here.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    plugins: { list: async () => ({ plugins: [], failures: [] }) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.getState().setCommandPaletteVisible(false));
});

const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-active], .overflow-y-auto > div'));
const activeIndex = () => rows().findIndex((r) => r.getAttribute('data-active') === 'true');

describe('CommandPalette active row', () => {
  it('follows the pointer, and arrow keys continue from there', () => {
    act(() => useStore.getState().setCommandPaletteVisible(true));
    act(() => root.render(createElement(CommandPalette)));
    expect(rows().length).toBeGreaterThan(3);
    expect(activeIndex()).toBe(0);

    act(() => {
      rows()[3].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(activeIndex()).toBe(3);
    // Exactly one row carries the selected look.
    expect(rows().filter((r) => r.getAttribute('data-active') === 'true')).toHaveLength(1);

    const input = container.querySelector('input') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(activeIndex()).toBe(4);
  });
});
