// @vitest-environment jsdom
// #1481 — the edge handle commits once on release, and a cancelled gesture
// commits nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SidebarResizeHandle, { widthForDrag } from '../SidebarResizeHandle';
import { useStore } from '../../../stores';

let container: HTMLDivElement;
let root: Root;

function fire(type: string, clientX: number) {
  const el = container.querySelector('[data-sidebar-resize]') as HTMLElement;
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 })); });
}

beforeEach(() => {
  act(() => useStore.setState({ sidebarWidth: 264, sidebarPosition: 'left' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SidebarResizeHandle />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SidebarResizeHandle', () => {
  it('moves only a guide during the drag and commits the width on release', () => {
    fire('pointerdown', 264);
    fire('pointermove', 324);
    expect(useStore.getState().sidebarWidth).toBe(264);
    expect(document.querySelector('[data-sidebar-resize-guide]')).not.toBeNull();
    fire('pointerup', 324);
    expect(useStore.getState().sidebarWidth).toBe(324);
    expect(document.querySelector('[data-sidebar-resize-guide]')).toBeNull();
  });

  it('commits nothing when the gesture is cancelled or loses capture', () => {
    fire('pointerdown', 264);
    fire('pointermove', 360);
    fire('pointercancel', 360);
    expect(useStore.getState().sidebarWidth).toBe(264);
    fire('pointerdown', 264);
    fire('pointermove', 360);
    fire('lostpointercapture', 360);
    fire('pointerup', 360);
    expect(useStore.getState().sidebarWidth).toBe(264);
  });

  it('resets to the default on double-click', () => {
    act(() => useStore.setState({ sidebarWidth: 380 }));
    fire('dblclick', 0);
    expect(useStore.getState().sidebarWidth).toBe(264);
  });

  it('flips the delta when docked right', () => {
    expect(widthForDrag(264, -40, 'right')).toBe(304);
    expect(widthForDrag(264, 1000, 'left')).toBe(400);
  });
});
