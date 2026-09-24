// @vitest-environment jsdom
//
// The Dialog primitive owns the three behaviours every modal used to hand-roll
// (or skip): focus stays inside while it is open, Escape closes the top-most
// dialog only, and focus goes back to whatever opened it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../Dialog';

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

const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return e;
};

function Sample({ onClose, description }: { onClose: () => void; description?: string }) {
  return createElement(
    Dialog,
    { onClose, 'data-testid': 'dlg' },
    createElement(DialogHeader, { title: 'Title', description, closeLabel: 'Close' }),
    createElement(DialogBody, null, createElement('button', { 'data-id': 'body' }, 'Body action')),
    createElement(
      DialogFooter,
      null,
      createElement('button', { 'data-id': 'cancel' }, 'Cancel'),
      createElement('button', { 'data-id': 'ok' }, 'OK'),
    ),
  );
}

describe('Dialog', () => {
  it('is a labelled, described modal dialog', () => {
    act(() => root.render(createElement(Sample, { onClose: () => undefined, description: 'More' })));
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(panel.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Title');
    const desc = document.getElementById(panel.getAttribute('aria-describedby') ?? '');
    expect(desc?.textContent).toBe('More');
  });

  it('omits aria-describedby when there is no description', () => {
    act(() => root.render(createElement(Sample, { onClose: () => undefined })));
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.hasAttribute('aria-describedby')).toBe(false);
  });

  it('moves focus in and wraps Tab / Shift+Tab inside the panel', () => {
    act(() => root.render(createElement(Sample, { onClose: () => undefined })));
    const close = container.querySelector('[aria-label="Close"]') as HTMLElement;
    const ok = container.querySelector('[data-id="ok"]') as HTMLElement;
    expect(document.activeElement).toBe(close);

    const back = key('Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ok);

    const fwd = key('Tab');
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('pulls focus back in when it has escaped the panel', () => {
    act(() => root.render(createElement(Sample, { onClose: () => undefined })));
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    key('Tab');
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Close"]'));
    outside.remove();
  });

  it('closes on Escape and stops the key reaching the app', () => {
    const onClose = vi.fn();
    const appHandler = vi.fn();
    window.addEventListener('keydown', appHandler);
    act(() => root.render(createElement(Sample, { onClose })));
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(appHandler).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appHandler);
  });

  it('lets the caller override or disable Escape', () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    act(() => root.render(createElement(Dialog, { onClose, onEscape }, createElement(DialogHeader, { title: 'T' }))));
    key('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => root.render(createElement(Dialog, { onClose, closeOnEscape: false }, createElement(DialogHeader, { title: 'T' }))));
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('only the top-most of two stacked dialogs reacts to Escape', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Dialog, { onClose: outer }, createElement(DialogHeader, { title: 'Outer' })),
          createElement(Dialog, { onClose: inner }, createElement(DialogHeader, { title: 'Inner' })),
        ),
      ),
    );
    key('Escape');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('returns focus to the opener when it closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return createElement(
        'div',
        null,
        createElement('button', { 'data-id': 'opener', onClick: () => setOpen(true) }, 'Open'),
        open ? createElement(Sample, { onClose: () => setOpen(false) }) : null,
      );
    }
    act(() => root.render(createElement(Harness)));
    const opener = container.querySelector('[data-id="opener"]') as HTMLButtonElement;
    opener.focus();
    act(() => opener.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(opener);

    key('Escape');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('honours initialFocusRef', () => {
    function WithRef() {
      const ref = { current: null as HTMLButtonElement | null };
      return createElement(
        Dialog,
        { onClose: () => undefined, initialFocusRef: ref },
        createElement(DialogHeader, { title: 'T', closeLabel: 'Close' }),
        createElement(DialogFooter, null, createElement('button', { ref: (el: HTMLButtonElement | null) => { ref.current = el; }, 'data-id': 'primary' }, 'Go')),
      );
    }
    act(() => root.render(createElement(WithRef)));
    expect(document.activeElement).toBe(container.querySelector('[data-id="primary"]'));
  });
});
