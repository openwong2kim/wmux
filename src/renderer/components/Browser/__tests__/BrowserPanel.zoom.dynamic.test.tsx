// @vitest-environment jsdom
//
// Page zoom from the pane's chrome: useKeyboard finds the browser pane whose
// chrome holds focus by its data-browser-panel marker and sends the step; the
// panel zooms its own page in Chrome's steps and ignores other panes' steps.
//
// Same harness as BrowserPanel.focus.dynamic.test.tsx: the REAL component via
// react-dom/client createRoot. jsdom renders <webview> as an HTMLUnknownElement,
// so the test gives it the two Electron zoom methods.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from '../BrowserPanel';
import { useStore } from '../../../stores';
import { BROWSER_ZOOM_EVENT, type BrowserZoomDetail } from '../../../../shared/browserZoom';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let factor: number;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(BrowserPanel, {
        surfaceId: 'surf-1',
        workspaceId: 'ws-test',
        initialUrl: 'https://example.com',
        partition: 'persist:test',
        isActive: true,
        onClose: () => undefined,
      }),
    );
  });
  const wv = container.querySelector('webview') as HTMLElement & Record<string, unknown>;
  wv.getZoomFactor = () => factor;
  wv.setZoomFactor = (f: number) => { factor = f; };
  act(() => {
    wv.dispatchEvent(new Event('dom-ready'));
  });
}

function zoom(detail: BrowserZoomDetail): void {
  act(() => {
    document.dispatchEvent(new CustomEvent(BROWSER_ZOOM_EVENT, { detail }));
  });
}

beforeEach(() => {
  factor = 1;
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {};
  act(() => {
    useStore.setState({ locale: 'en' });
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BrowserPanel — page zoom', () => {
  it('marks its root so the focused pane can be found from its address bar', () => {
    mount();
    const input = container.querySelector('input');
    expect(input?.closest<HTMLElement>('[data-browser-panel]')?.dataset.browserPanel).toBe('surf-1');
  });

  it("zooms its own page in Chrome's steps and resets", () => {
    mount();
    zoom({ surfaceId: 'surf-1', step: 'in' });
    zoom({ surfaceId: 'surf-1', step: 'in' });
    expect(factor).toBe(1.25);
    zoom({ surfaceId: 'surf-1', step: 'reset' });
    expect(factor).toBe(1);
  });

  it("ignores another pane's step", () => {
    mount();
    zoom({ surfaceId: 'surf-2', step: 'in' });
    expect(factor).toBe(1);
  });
});
