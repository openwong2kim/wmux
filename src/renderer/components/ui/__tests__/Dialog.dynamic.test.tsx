// @vitest-environment jsdom
//
// The Dialog primitive owns the three behaviours every modal used to hand-roll
// (or skip): focus stays inside while it is open, Escape closes the top-most
// dialog only, and focus goes back to whatever opened it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Dialog, { DialogBody, DialogFooter, DialogHeader, focusableWithin } from '../Dialog';

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

  it('leaves Tab alone when focus was deliberately moved outside (e.g. into a terminal)', () => {
    act(() => root.render(createElement(Sample, { onClose: () => undefined })));
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const e = key('Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('puts focus back inside when a re-render removes the focused control', async () => {
    function Removing() {
      const [show, setShow] = useState(true);
      return createElement(
        Dialog,
        { onClose: () => undefined },
        createElement(DialogHeader, { title: 'T', closeLabel: 'Close' }),
        createElement(DialogBody, null,
          show ? createElement('button', { 'data-id': 'go', onClick: () => setShow(false) }, 'Register') : createElement('span', null, 'Done'),
        ),
      );
    }
    act(() => root.render(createElement(Removing)));
    const go = container.querySelector('[data-id="go"]') as HTMLButtonElement;
    go.focus();
    await act(async () => {
      go.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-id="go"]')).toBeNull();
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(panel.contains(document.activeElement)).toBe(true);
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

  it('ignores Escape while an IME composition is active', () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(Sample, { onClose })));
    const composing = key('Escape', { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);
    key('Escape', { keyCode: 229 } as KeyboardEventInit);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops a capture-phase app listener (e.g. Settings) from also handling the same Escape', () => {
    const onClose = vi.fn();
    const settingsEscape = vi.fn();
    // Registered before the dialog opens, as the Settings panel's is.
    window.addEventListener('keydown', settingsEscape, true);
    act(() => root.render(createElement(Sample, { onClose })));
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(settingsEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', settingsEscape, true);
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

  it('a dialog nested inside another is the top-most one', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    act(() =>
      root.render(
        createElement(
          Dialog,
          { onClose: outer },
          createElement(DialogHeader, { title: 'Outer' }),
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

  it('can be an alertdialog, still modal and labelled by its title', () => {
    act(() => root.render(createElement(Dialog, { onClose: () => undefined, role: 'alertdialog' }, createElement(DialogHeader, { title: 'Approve?' }))));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const panel = container.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(panel.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Approve?');
  });

  describe('focusOnOpen="none" (a dialog the app opens by itself)', () => {
    function Passive({ onClose }: { onClose: () => void }) {
      return createElement(
        Dialog,
        { onClose, focusOnOpen: 'none', 'data-testid': 'passive' },
        createElement(DialogHeader, { title: 'Approve?' }),
        createElement(DialogFooter, null, createElement('button', { 'data-id': 'deny' }, 'Deny')),
      );
    }

    it('leaves an editing focus where it is and lets its keys through', () => {
      const editor = document.createElement('textarea');
      document.body.appendChild(editor);
      editor.focus();
      const onClose = vi.fn();
      act(() => root.render(createElement(Passive, { onClose })));
      expect(document.activeElement).toBe(editor);
      // The panel itself is not a focus target, so a click on it cannot take
      // focus from the terminal either.
      expect(container.querySelector('[data-testid="passive"]')?.hasAttribute('tabindex')).toBe(false);
      const esc = key('Escape');
      expect(onClose).not.toHaveBeenCalled();
      expect(esc.defaultPrevented).toBe(false);
      editor.remove();
    });

    it('handles Escape once the user has moved focus into it', () => {
      const onClose = vi.fn();
      act(() => root.render(createElement(Passive, { onClose })));
      (container.querySelector('[data-id="deny"]') as HTMLButtonElement).focus();
      key('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not take the keyboard from a dialog the user opened, even when it arrives later', () => {
      const userDialog = vi.fn();
      const arrived = vi.fn();
      act(() => root.render(createElement('div', null, createElement(Sample, { onClose: userDialog }))));
      const body = container.querySelector('[data-id="body"]') as HTMLButtonElement;
      body.focus();
      act(() =>
        root.render(
          createElement('div', null, createElement(Sample, { onClose: userDialog }), createElement(Passive, { onClose: arrived })),
        ),
      );
      expect(document.activeElement).toBe(body);
      // Tab still wraps inside the user's dialog...
      (container.querySelector('[data-id="ok"]') as HTMLButtonElement).focus();
      key('Tab');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
      // ...and Escape closes it, not the dialog that arrived.
      key('Escape');
      expect(userDialog).toHaveBeenCalledTimes(1);
      expect(arrived).not.toHaveBeenCalled();
    });
  });

  it('closeDisabled disables the header close button', () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(Dialog, { onClose }, createElement(DialogHeader, { title: 'T', closeLabel: 'Close', closeDisabled: true }))));
    const close = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    act(() => close.click());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('focusableWithin', () => {
  it('skips negative tabindex, hidden and aria-hidden subtrees', () => {
    const rootEl = document.createElement('div');
    rootEl.innerHTML = `
      <button data-id="a">a</button>
      <button tabindex="-1" data-id="roving">b</button>
      <div hidden><button data-id="hidden">c</button></div>
      <div aria-hidden="true"><button data-id="aria">d</button></div>
      <div inert><button data-id="inert">e</button></div>
      <button disabled data-id="disabled">f</button>
      <span tabindex="0" data-id="span">g</span>`;
    document.body.appendChild(rootEl);
    expect(focusableWithin(rootEl).map((el) => el.dataset.id)).toEqual(['a', 'span']);
    rootEl.remove();
  });
});
