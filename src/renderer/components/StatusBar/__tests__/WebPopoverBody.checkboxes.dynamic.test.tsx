// @vitest-environment jsdom
//
// The Remote popover's options used to be native checkboxes wrapped in a
// <label>, so clicking the text toggled them and Space did too. As token
// checkboxes inside a Field they must keep both: the Field's <label for>
// activates the checkbox, Space toggles it, and Enter does not (a native
// checkbox ignores Enter).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebPopoverBody, type WebPopoverBodyProps } from '../WebToggle';

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

const t = (key: string): string => key;

function Harness({ running = false }: { running?: boolean }) {
  const [allowInput, setAllowInput] = useState(false);
  const [tailscale, setTailscale] = useState(false);
  const [expose, setExpose] = useState(false);
  const [pairAllowInput, setPairAllowInput] = useState(false);
  const noop = vi.fn();
  const props: WebPopoverBodyProps = {
    info: running ? { running: true, host: '127.0.0.1', port: 7681, urls: ['http://127.0.0.1:7681/'] } : { running: false },
    allowInput,
    expose,
    tailscale,
    busy: false,
    copied: null,
    deviceName: '',
    qr: null,
    onToggleAllowInput: () => setAllowInput((v) => !v),
    onToggleExpose: () => setExpose((v) => !v),
    onToggleTailscale: () => setTailscale((v) => !v),
    onStart: noop,
    onStop: noop,
    onCopyUrl: noop,
    onCopyPairUrl: noop,
    onCopyPairCode: noop,
    onOpenUrl: noop,
    onOpenLink: noop,
    onNewPairCode: noop,
    onDeviceNameChange: noop,
    onStartPairing: noop,
    onOpenDevices: noop,
    pairAllowInput,
    onTogglePairAllowInput: () => setPairAllowInput((v) => !v),
    t,
  };
  return createElement(WebPopoverBody, props);
}

function checkboxFor(labelText: string): { label: HTMLLabelElement; box: HTMLButtonElement } {
  const label = Array.from(container.querySelectorAll('label')).find((l) => l.textContent === labelText);
  if (!label) throw new Error(`no label ${labelText}`);
  const box = document.getElementById(label.htmlFor) as HTMLButtonElement;
  expect(box.getAttribute('role')).toBe('checkbox');
  return { label: label as HTMLLabelElement, box };
}

function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('Remote popover options', () => {
  it.each(['web.allowInput', 'web.tailscale', 'web.expose'])('%s toggles from its label text', (key) => {
    act(() => root.render(createElement(Harness)));
    const { label, box } = checkboxFor(key);
    expect(box.getAttribute('aria-checked')).toBe('false');
    act(() => label.click());
    expect(box.getAttribute('aria-checked')).toBe('true');
    act(() => label.click());
    expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles on Space and ignores Enter, like the native checkbox it replaced', () => {
    act(() => root.render(createElement(Harness)));
    const { box } = checkboxFor('web.allowInput');
    press(box, 'Enter');
    expect(box.getAttribute('aria-checked')).toBe('false');
    press(box, ' ');
    expect(box.getAttribute('aria-checked')).toBe('true');
  });

  it('"Let this device type" toggles from its label text in the running body', () => {
    act(() => root.render(createElement(Harness, { running: true })));
    const { label, box } = checkboxFor('web.pairAllowInput');
    act(() => label.click());
    expect(box.getAttribute('aria-checked')).toBe('true');
  });
});
