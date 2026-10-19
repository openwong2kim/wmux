// @vitest-environment jsdom
//
// The element picker survives a full navigation: the new document has no
// overlay, so the panel injects it again while picking is on, and stops once
// picking is off.
//
// Same harness as BrowserPanel.focus.dynamic.test.tsx: the REAL component via
// react-dom/client createRoot. jsdom renders <webview> as an HTMLUnknownElement,
// so the test gives it the one Electron method the picker calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from '../BrowserPanel';
import { useStore } from '../../../stores';
import { beginPrivateSessionClear } from '../../../utils/privateSessionGate';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let executeJavaScript: ReturnType<typeof vi.fn>;

function render(partition = 'persist:test'): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(BrowserPanel, {
        surfaceId: 'surf-1',
        workspaceId: 'ws-test',
        initialUrl: 'https://example.com',
        partition,
        isActive: true,
        onClose: () => undefined,
      }),
    );
  });
}

function attachWebview(): HTMLElement {
  const wv = container.querySelector('webview') as HTMLElement & { executeJavaScript?: unknown };
  if (!wv) throw new Error('webview not rendered');
  wv.executeJavaScript = executeJavaScript;
  return wv;
}

function domReady(wv: HTMLElement): void {
  act(() => {
    wv.dispatchEvent(new Event('dom-ready'));
  });
}

function clickPicker(label: string): void {
  const btn = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!btn) throw new Error(`no button "${label}"`);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function mount(): HTMLElement {
  render();
  return attachWebview();
}

const injections = () => executeJavaScript.mock.calls.filter(([src]) => String(src).includes('__wmux_inspector_overlay')).length;

beforeEach(() => {
  executeJavaScript = vi.fn(async () => undefined);
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

describe('BrowserPanel — element picker across navigation', () => {
  it('injects the overlay again when a new page loads while picking', () => {
    const wv = mount();
    domReady(wv);
    clickPicker('Pick an element for the agent');
    expect(injections()).toBe(1);
    domReady(wv);
    expect(injections()).toBe(2);
  });

  it('injects on the first page load when picking started before the page was ready', () => {
    // The state a discarded page wakes into: picking on, isReady false.
    const wv = mount();
    clickPicker('Pick an element for the agent');
    expect(injections()).toBe(0);
    domReady(wv);
    expect(injections()).toBe(1);
  });

  it('injects on the first page load when picking started before a private tab mounted its page', async () => {
    // A private tab waits for the previous private session's wipe before it
    // mounts the <webview>; the toolbar is already usable meanwhile.
    let finishClear!: () => void;
    beginPrivateSessionClear(() => new Promise<void>((resolve) => { finishClear = resolve; }));
    render('wmux-private');
    expect(container.querySelector('webview')).toBeNull();
    clickPicker('Pick an element for the agent');
    await act(async () => {
      finishClear();
      await Promise.resolve();
    });
    const wv = attachWebview();
    domReady(wv);
    expect(injections()).toBe(1);
  });

  it('leaves a new page alone once picking is off', () => {
    const wv = mount();
    domReady(wv);
    clickPicker('Pick an element for the agent');
    clickPicker('Stop picking');
    domReady(wv);
    expect(injections()).toBe(1);
  });
});
