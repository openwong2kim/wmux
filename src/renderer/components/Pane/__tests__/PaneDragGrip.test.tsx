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

const focusPaneSurface = vi.hoisted(() => vi.fn(() => true));
const movePane = vi.hoisted(() => vi.fn(() => true));
const swapPanes = vi.hoisted(() => vi.fn(() => true));
const setPaneDropTarget = vi.hoisted(() => vi.fn());
const setPaneDragSource = vi.hoisted(() => vi.fn());

vi.mock('../../../stores', () => ({
  useStore: (sel: (s: unknown) => unknown) =>
    sel({ focusPaneSurface, movePane, swapPanes, setPaneDropTarget, setPaneDragSource }),
}));
vi.mock('../../../i18n', () => ({ t: (k: string) => k }));

import PaneDragGrip from '../PaneDragGrip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let grip: HTMLElement;

/** jsdom has no pointer capture; the component calls it unconditionally. */
function stubCapture(el: HTMLElement) {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
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
  it('a plain click moves nothing and is left to bubble', () => {
    // The grip does NOT focus the pane itself: it lets the click through so
    // the pane root focuses as usual and, in multiview, the tile activates
    // its workspace. See the click-through test below.
    pointer('pointerdown', 10, 10);
    pointer('pointerup', 10, 10);
    act(() => { grip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

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
    expect(focusPaneSurface).not.toHaveBeenCalled();
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

  it('ends the drag when the browser revokes the pointer capture', () => {
    // lostpointercapture arrives without a pointercancel when the element is
    // removed or the OS takes the pointer. Without handling it the drag would
    // sit waiting for moves that never come. (Found by the Codex reviewer.)
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 90, 90);
    setPaneDropTarget.mockClear();
    setPaneDragSource.mockClear();

    act(() => {
      grip.dispatchEvent(new MouseEvent('lostpointercapture', { bubbles: true }));
    });

    expect(setPaneDragSource).toHaveBeenCalledWith(null);
    expect(setPaneDropTarget).toHaveBeenCalledWith(null);
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

  it('lets a plain click through, but swallows the one that ends a drag', () => {
    // The pane root (and, in multiview, the workspace tile) has its own click
    // handler. A plain grip click must reach it — swallowing every click made
    // the grip the one spot in a background tile that did nothing at all.
    // The click that TERMINATES a drag must still be swallowed, or a
    // cancelled drag would move focus.
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

    // Plain click → reaches the pane root.
    pointer('pointerdown', 10, 10);
    pointer('pointerup', 10, 10);
    act(() => { grip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onPaneRootClick).toHaveBeenCalledTimes(1);

    // Drag, then its trailing click → swallowed.
    onPaneRootClick.mockClear();
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 90, 90);
    pointer('pointerup', 90, 90);
    act(() => { grip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onPaneRootClick).not.toHaveBeenCalled();
  });

  it('focuses the dragged pane after a centre-drop swap', () => {
    // swapPanes deliberately does not touch focus, so without this the pane
    // the user just dragged stays inactive after a centre drop — unlike an
    // edge drop, which focuses via movePane's focusSource. The focus call must
    // be the explicit-workspace one: setActivePane resolves paneIds against
    // activeWorkspaceId only and would silently refuse a background tile.
    // (Found by the Codex reviewer.)
    const other = document.createElement('div');
    other.setAttribute('data-pane-root', 'pane-b');
    other.setAttribute('data-pane-workspace', 'ws-1');
    other.getBoundingClientRect = () =>
      ({ left: 200, top: 200, width: 200, height: 200 }) as DOMRect;
    document.body.appendChild(other);

    pointer('pointerdown', 10, 10);
    pointer('pointermove', 300, 300); // dead centre of pane-b → a swap
    pointer('pointerup', 300, 300);

    expect(swapPanes).toHaveBeenCalledWith('ws-1', 'pane-a', 'pane-b');
    expect(focusPaneSurface).toHaveBeenCalledWith('ws-1', 'pane-a');
    expect(movePane).not.toHaveBeenCalled();
    other.remove();
  });

  it('focuses via movePane, not a second call, on an edge drop', () => {
    const other = document.createElement('div');
    other.setAttribute('data-pane-root', 'pane-b');
    other.setAttribute('data-pane-workspace', 'ws-1');
    other.getBoundingClientRect = () =>
      ({ left: 200, top: 200, width: 200, height: 200 }) as DOMRect;
    document.body.appendChild(other);

    pointer('pointerdown', 10, 10);
    pointer('pointermove', 210, 300); // left band of pane-b
    pointer('pointerup', 210, 300);

    expect(movePane).toHaveBeenCalledWith('ws-1', 'pane-a', 'pane-b', 'left', { focusSource: true });
    expect(swapPanes).not.toHaveBeenCalled();
    other.remove();
  });
});
