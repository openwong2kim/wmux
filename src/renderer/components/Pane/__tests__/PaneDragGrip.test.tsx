// @vitest-environment jsdom
//
// Issue #645 — the grip's gesture contract.
//
// Both cases here are regressions caught in a live dev build, not invented:
//
//   1. Escape mid-drag left the tree alone but MOVED FOCUS. `pointerup` was
//      overwriting the "this was a drag" latch with `draggingRef`, which
//      Escape had already cleared — so the trailing click looked like a plain
//      click and focused the pane. "Cancel changes nothing" was a lie.
//   2. A click on the grip must still focus its pane, and must not reach the
//      pane root (whose own click handler would double-handle it).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const setActivePane = vi.hoisted(() => vi.fn());
const movePane = vi.hoisted(() => vi.fn());
const swapPanes = vi.hoisted(() => vi.fn());
const setPaneDropTarget = vi.hoisted(() => vi.fn());
const setPaneDragSource = vi.hoisted(() => vi.fn());

vi.mock('../../../stores', () => ({
  useStore: (sel: (s: unknown) => unknown) =>
    sel({ setActivePane, movePane, swapPanes, setPaneDropTarget, setPaneDragSource }),
}));
vi.mock('../../../i18n', () => ({ t: (k: string) => k }));

import PaneDragGrip from '../PaneDragGrip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let grip: HTMLElement;

/** jsdom has no pointer capture; the component calls it unconditionally. */
function stubCapture(el: HTMLElement) {
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.hasPointerCapture = () => false;
}

function pointer(type: string, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  act(() => { grip.dispatchEvent(e); });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(PaneDragGrip, { paneId: 'pane-a', workspaceId: 'ws-1' }));
  });
  grip = container.querySelector('[data-pane-drag-grip]')!;
  stubCapture(grip);
});

describe('PaneDragGrip', () => {
  it('a click with no movement focuses the pane and moves nothing', () => {
    pointer('pointerdown', 10, 10);
    pointer('pointerup', 10, 10);
    act(() => { grip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(setActivePane).toHaveBeenCalledWith('pane-a');
    expect(movePane).not.toHaveBeenCalled();
    expect(swapPanes).not.toHaveBeenCalled();
  });

  it('movement under the threshold is still a click', () => {
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 12, 11); // ~2.2px — below the 4px threshold
    expect(setPaneDragSource).not.toHaveBeenCalled();
  });

  it('Escape mid-drag leaves focus alone (the live regression)', () => {
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 80, 80); // well past the threshold → a real drag
    expect(setPaneDragSource).toHaveBeenCalledWith('pane-a');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    pointer('pointerup', 80, 80);
    act(() => { grip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // The whole point: a cancelled drag changes NOTHING.
    expect(movePane).not.toHaveBeenCalled();
    expect(swapPanes).not.toHaveBeenCalled();
    expect(setActivePane).not.toHaveBeenCalled();
    expect(setPaneDropTarget).toHaveBeenLastCalledWith(null);
  });

  it('clears the drag when the grip unmounts mid-drag', () => {
    // An agent or the daemon can close a pane while the user is dragging it.
    // The grip then unmounts having seen neither pointerup nor pointercancel
    // nor Escape, and without a cleanup the store keeps paneDropTarget set —
    // painting a drop indicator on some pane forever. (Found by GLM review.)
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 90, 90); // a real drag is in flight
    expect(setPaneDragSource).toHaveBeenCalledWith('pane-a');
    setPaneDropTarget.mockClear();
    setPaneDragSource.mockClear();

    act(() => { root.unmount(); });

    expect(setPaneDragSource).toHaveBeenCalledWith(null);
    expect(setPaneDropTarget).toHaveBeenCalledWith(null);
    root = createRoot(container); // keep the shared teardown valid
  });

  it('does not touch drag state when it unmounts with no gesture in flight', () => {
    setPaneDropTarget.mockClear();
    setPaneDragSource.mockClear();

    act(() => { root.unmount(); });

    // Every pane has a grip; a pane closing while ANOTHER pane is being
    // dragged must not clear that drag.
    expect(setPaneDragSource).not.toHaveBeenCalled();
    expect(setPaneDropTarget).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it('does not let its click reach the pane root', () => {
    // Mirror the real structure: the pane root is a React element WRAPPING the
    // grip, with its own onClick (click-to-focus). A native listener on the
    // React root container would fire regardless — React delegates there, so
    // the event has already bubbled past it before synthetic dispatch.
    const onPaneRootClick = vi.fn();
    act(() => {
      root.render(
        React.createElement(
          'div',
          { onClick: onPaneRootClick },
          React.createElement(PaneDragGrip, { paneId: 'pane-a', workspaceId: 'ws-1' }),
        ),
      );
    });
    grip = container.querySelector('[data-pane-drag-grip]')!;
    stubCapture(grip);

    pointer('pointerdown', 10, 10);
    pointer('pointerup', 10, 10);
    act(() => { grip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(setActivePane).toHaveBeenCalledWith('pane-a'); // the grip focuses it
    expect(onPaneRootClick).not.toHaveBeenCalled(); // exactly once, not twice
  });
});
