// @vitest-environment jsdom
//
// PresetPicker anchoring contract (owner-reported 2026-07-13): rendered from
// the TITLEBAR + button the picker must use the passed viewport-fixed anchor —
// the legacy `absolute right-2 top-10` classes resolved against the full-width
// header and the menu opened at the far RIGHT edge of the window. The sidebar
// call site passes no anchor and keeps the legacy placement.

import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import PresetPicker from '../PresetPicker';

function render(ui: React.ReactElement): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('PresetPicker anchoring', () => {
  it('uses the viewport-fixed anchor when one is passed (titlebar call site)', () => {
    const { container, cleanup } = render(
      <PresetPicker onClose={() => {}} anchorStyle={{ left: 204, top: 40 }} />,
    );
    cleanups.push(cleanup);
    const menu = container.firstElementChild as HTMLElement;
    expect(menu.className).toContain('fixed');
    expect(menu.className).not.toContain('right-2');
    expect(menu.style.left).toBe('204px');
    expect(menu.style.top).toBe('40px');
  });

  it('keeps the legacy sidebar placement when no anchor is passed', () => {
    const { container, cleanup } = render(<PresetPicker onClose={() => {}} />);
    cleanups.push(cleanup);
    const menu = container.firstElementChild as HTMLElement;
    expect(menu.className).toContain('absolute');
    expect(menu.className).toContain('right-2');
  });
});
