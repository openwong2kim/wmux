// @vitest-environment jsdom
//
// #252 — BrowserPanel keyboard-focus DYNAMIC harness.
//
// Symptom: in a browser pane the mouse works but no keyboard input reaches the
// page. useActivePaneFocus deliberately skips browser/editor surfaces (they
// have no xterm), so DOM keyboard focus is never moved onto the <webview>; it
// stays on the previously focused terminal / <body> and every keystroke is
// dropped. The fix gives BrowserPanel its own focus path:
//   1. a useEffect that calls webviewRef.current.focus() when the surface is
//      active AND visible AND the webview is dom-ready, and
//   2. an onClick on the pane container that focuses the webview (so toolbar /
//      chrome / pane-switch clicks focus it too).
//
// This mounts the REAL <BrowserPanel/> via react-dom/client createRoot so its
// effects run, drives `dom-ready` to flip the internal `isReady` state, and
// asserts webview.focus() is (or is not) called. End-to-end keystroke delivery
// in a live Electron <webview> cannot be exercised in jsdom — the load-bearing
// proof here is that .focus() is invoked under exactly the right conditions.
//
// jsdom renders <webview> as an HTMLUnknownElement which still carries the
// HTMLElement.focus() method; we replace that element's own `focus` with a
// vi.fn() spy AFTER mount (so the spy is in place before the state change that
// should trigger it) and assert on the call count. Electron-only webview APIs
// (getWebContentsId, canGoBack, …) are absent in jsdom; the component already
// guards them with optional chaining / try-catch, so dom-ready is a no-op
// beyond setting isReady.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from '../BrowserPanel';
import { useStore } from '../../../stores';

// React 19 ships act() from the package root.
const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Mount lifecycle ────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

interface MountProps {
  isActive: boolean;
  visible?: boolean;
  surfaceId?: string;
}

function mount(props: MountProps): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(BrowserPanel, {
        surfaceId: props.surfaceId ?? 'surf-1',
        workspaceId: 'ws-test',
        initialUrl: 'https://example.com',
        partition: 'persist:test',
        isActive: props.isActive,
        visible: props.visible,
        onClose: () => {},
      }),
    );
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** The rendered <webview> intrinsic (HTMLUnknownElement in jsdom). */
function webviewEl(surfaceId = 'surf-1'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`webview[data-surface-id="${surfaceId}"]`);
  if (!el) throw new Error('webview element not rendered');
  return el;
}

/** Replace the webview's own focus() with a spy (after mount, before trigger). */
function spyWebviewFocus(surfaceId = 'surf-1'): ReturnType<typeof vi.fn> {
  const el = webviewEl(surfaceId);
  const fn = vi.fn();
  el.focus = fn;
  return fn;
}

/** Flip the component's internal isReady by firing the webview's dom-ready. */
function fireDomReady(surfaceId = 'surf-1'): void {
  const el = webviewEl(surfaceId);
  act(() => {
    el.dispatchEvent(new Event('dom-ready'));
  });
}

/** The outer pane container that carries the click-to-focus handler. */
function paneContainer(): HTMLElement {
  const el = container.firstElementChild as HTMLElement | null;
  if (!el) throw new Error('pane container not rendered');
  return el;
}

beforeEach(() => {
  // The component subscribes to `locale` (useT) and calls updateBrowserUrl on
  // navigation; a clean known store keeps both deterministic.
  act(() => {
    useStore.setState({ locale: 'en' });
  });
});

afterEach(() => {
  try {
    unmount();
  } catch {
    /* some tests unmount themselves */
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BrowserPanel — webview keyboard focus (#252)', () => {
  it('focuses the webview once it becomes dom-ready while active', () => {
    mount({ isActive: true });
    // Before dom-ready: isReady is false, so the focus effect must not fire.
    const focus = spyWebviewFocus();
    expect(focus).not.toHaveBeenCalled();

    fireDomReady();

    // dom-ready flips isReady → the active surface grabs DOM focus.
    expect(focus).toHaveBeenCalled();
  });

  it('does NOT focus the webview when the surface is not active (split background side)', () => {
    // A terminal+browser split: this browser is rendered (visible) but the
    // terminal side holds focus (isActive=false). It must not steal focus.
    mount({ isActive: false, visible: true });
    const focus = spyWebviewFocus();

    fireDomReady();

    expect(focus).not.toHaveBeenCalled();
  });

  it('does NOT focus the webview when active but not yet ready', () => {
    mount({ isActive: true });
    const focus = spyWebviewFocus();
    // No dom-ready fired → guest webContents not up yet → no focus.
    expect(focus).not.toHaveBeenCalled();
  });

  it('focuses the webview when the pane container is clicked', () => {
    // Even an inactive/not-ready surface should focus on an explicit click —
    // this is the toolbar / chrome / pane-switch click path.
    mount({ isActive: false, visible: true });
    const focus = spyWebviewFocus();

    act(() => {
      paneContainer().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('focuses on click independently of the active-surface effect', () => {
    mount({ isActive: true });
    const focus = spyWebviewFocus();
    // Click before dom-ready: the effect has not fired, so the only call is the
    // click handler's — proving the click path stands on its own.
    act(() => {
      paneContainer().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('focuses when becoming active after already being ready (active toggles last)', () => {
    // Start visible but inactive and let it become ready (no focus yet), then
    // make it the active surface — focus must follow the active flip.
    mount({ isActive: false, visible: true });
    fireDomReady();
    const focus = spyWebviewFocus();
    expect(focus).not.toHaveBeenCalled();

    act(() => {
      root.render(
        React.createElement(BrowserPanel, {
          surfaceId: 'surf-1',
          workspaceId: 'ws-test',
          initialUrl: 'https://example.com',
          partition: 'persist:test',
          isActive: true,
          visible: true,
          onClose: () => {},
        }),
      );
    });

    expect(focus).toHaveBeenCalled();
  });
});
