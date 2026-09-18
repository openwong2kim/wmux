// @vitest-environment jsdom
//
// browser_request_help — the in-pane bar, mounted for real.
//
// The bar is the FIRST of the event's two renditions (the Fleet inbox row is the
// second), so what has to hold here is: it appears only for ITS OWN surface, the
// agent-authored prompt reaches the DOM as TEXT and never as markup, and Done /
// Cancel each send exactly one outcome over the preload bridge and drop the row
// locally.
//
// Same harness as BrowserPanel.focus.dynamic.test.tsx: the REAL component via
// react-dom/client createRoot so its effects and store subscriptions run. jsdom
// renders <webview> as an HTMLUnknownElement, and the Electron-only webview APIs
// the component touches are already optional-chained, so mounting is safe.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from '../BrowserPanel';
import { useStore } from '../../../stores';
import type { BrowserHelpRequestInfo } from '../../../../shared/browserHelp';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let resolveSpy: ReturnType<typeof vi.fn>;

function mount(surfaceId = 'surf-1'): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(BrowserPanel, {
        surfaceId,
        workspaceId: 'ws-test',
        initialUrl: 'https://example.com',
        partition: 'persist:test',
        isActive: true,
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

function helpRequest(overrides: Partial<BrowserHelpRequestInfo> = {}): BrowserHelpRequestInfo {
  return {
    requestId: 'req-1',
    workspaceId: 'ws-test',
    surfaceId: 'surf-1',
    prompt: 'Sign in and solve the CAPTCHA, then press Done.',
    deadlineAt: Date.now() + 300_000,
    ...overrides,
  };
}

/** Put one open ask in the store, as the bridge hook would. */
function openHelp(info: BrowserHelpRequestInfo): void {
  act(() => {
    useStore.getState().addBrowserHelpRequest(info);
  });
}

const bar = () => container.querySelector<HTMLElement>('[data-browser-help-bar]');
const promptEl = () => container.querySelector<HTMLElement>('[data-browser-help-prompt]');
const doneBtn = () => container.querySelector<HTMLButtonElement>('[data-browser-help-done]');
const cancelBtn = () => container.querySelector<HTMLButtonElement>('[data-browser-help-cancel]');

function click(el: HTMLElement | null): void {
  if (!el) throw new Error('element not rendered');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  resolveSpy = vi.fn(async () => ({ ok: true }));
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    browserHelp: { resolve: resolveSpy, onOpen: () => () => {}, onClosed: () => () => {} },
  };
  act(() => {
    useStore.setState({ locale: 'en', browserHelpRequests: {}, browserHelpOrder: [] });
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

describe('BrowserPanel — browser_request_help bar', () => {
  it('renders nothing while no help request is open', () => {
    mount();
    expect(bar()).toBeNull();
  });

  it('shows the prompt, a Done button and a Cancel button for its own surface', () => {
    mount();
    openHelp(helpRequest());
    expect(bar()).not.toBeNull();
    expect(promptEl()?.textContent).toBe('Sign in and solve the CAPTCHA, then press Done.');
    expect(doneBtn()?.textContent).toBe('Done');
    expect(cancelBtn()?.textContent).toBe('Cancel');
  });

  it('ignores a request that belongs to another surface', () => {
    mount('surf-1');
    openHelp(helpRequest({ surfaceId: 'surf-2' }));
    expect(bar()).toBeNull();
  });

  it('renders the agent-authored prompt as TEXT, never as markup', () => {
    mount();
    const hostile = '<img src=x onerror="window.__pwned=1"> <b>bold</b>';
    openHelp(helpRequest({ prompt: hostile }));
    // The characters are all there…
    expect(promptEl()?.textContent).toBe(hostile);
    // …and none of them became nodes.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(promptEl()?.children.length).toBe(0);
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('Done resolves the request as `continued` and clears the bar', () => {
    mount();
    openHelp(helpRequest());
    click(doneBtn());
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith('req-1', 'continued');
    // Optimistic local removal — the authoritative one is main's CLOSED push.
    expect(useStore.getState().browserHelpOrder).toEqual([]);
    expect(bar()).toBeNull();
  });

  it('Cancel resolves the request as `cancelled` and clears the bar', () => {
    mount();
    openHelp(helpRequest());
    click(cancelBtn());
    expect(resolveSpy).toHaveBeenCalledWith('req-1', 'cancelled');
    expect(useStore.getState().browserHelpOrder).toEqual([]);
    expect(bar()).toBeNull();
  });

  it('clears the bar when main pushes the close (timeout / auto-completion)', () => {
    mount();
    openHelp(helpRequest());
    act(() => {
      useStore.getState().removeBrowserHelpRequest('req-1');
    });
    expect(bar()).toBeNull();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('keeps the band compact and does not spend a 36px chrome row', () => {
    mount();
    openHelp(helpRequest());
    // DESIGN.md: the inspector-toast slot is a transient ~30px band, not a
    // 36px chrome module.
    expect(bar()?.style.minHeight).toBe('30px');
  });

  it('gives both buttons a hit area of at least 24x24 and a 5px radius', () => {
    mount();
    openHelp(helpRequest());
    for (const el of [doneBtn(), cancelBtn()]) {
      expect(parseInt(el?.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(24);
      expect(parseInt(el?.style.minWidth ?? '0', 10)).toBeGreaterThanOrEqual(24);
      expect(el?.className).toContain('rounded-[5px]');
    }
  });

  it('spends the ONE solid warm fill on Done and leaves Cancel neutral', () => {
    mount();
    openHelp(helpRequest());
    // DESIGN.md "Primary action = solid warm fill"; secondary = raised neutral.
    expect(doneBtn()?.style.backgroundColor).toBe('var(--accent)');
    expect(cancelBtn()?.style.backgroundColor).not.toContain('var(--accent)');
  });
});
