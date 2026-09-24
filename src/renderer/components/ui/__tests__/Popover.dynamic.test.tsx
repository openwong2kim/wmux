// @vitest-environment jsdom
//
// Popover: the quiet panel classes (with the surface scope that flattens the
// controls inside it) and the section header model.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Popover, { PopoverSection } from '../Popover';

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

describe('Popover', () => {
  it('is a dialog on the surface scope by default, and forwards its ref and attributes', () => {
    const ref = createRef<HTMLDivElement>();
    act(() =>
      root.render(
        createElement(Popover, { ref, 'aria-label': 'Remote', 'data-testid': 'pop', className: 'fixed w-80' }, 'x'),
      ),
    );
    const el = container.querySelector('[data-testid="pop"]') as HTMLDivElement;
    expect(ref.current).toBe(el);
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-label')).toBe('Remote');
    // ui-surface is what flattens buttons and inputs inside the panel.
    expect(el.className.split(' ')).toEqual(
      expect.arrayContaining(['ui-popover', 'ui-surface', 'fixed', 'w-80']),
    );
    expect(el.classList.contains('ui-popover-padded')).toBe(false);
  });

  it('takes the wider inset when padded, and a caller role', () => {
    act(() => root.render(createElement(Popover, { padded: true, role: 'menu', 'data-testid': 'pop' })));
    const el = container.querySelector('[data-testid="pop"]') as HTMLDivElement;
    expect(el.classList.contains('ui-popover-padded')).toBe(true);
    expect(el.getAttribute('role')).toBe('menu');
  });
});

describe('PopoverSection', () => {
  it('renders a header with its trailing action, and the title id', () => {
    act(() =>
      root.render(
        createElement(
          PopoverSection,
          { title: 'Sources', titleId: 'src-title', action: createElement('button', { type: 'button' }, '+') },
          createElement('div', { className: 'ui-section-row' }, 'row'),
        ),
      ),
    );
    const header = container.querySelector('.ui-section-header') as HTMLElement;
    expect(document.getElementById('src-title')?.textContent).toBe('Sources');
    expect(header.querySelector('button')?.textContent).toBe('+');
    expect(container.querySelector('.ui-section > .ui-section-row')?.textContent).toBe('row');
  });

  it('draws no header when it has neither title nor action', () => {
    act(() => root.render(createElement(PopoverSection, null, 'body')));
    expect(container.querySelector('.ui-section-header')).toBeNull();
    expect(container.querySelector('.ui-section')?.textContent).toBe('body');
  });
});
