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

function Harness({ running = false, initialUpload = false }: { running?: boolean; initialUpload?: boolean }) {
  const [allowInput, setAllowInput] = useState(false);
  const [tailscale, setTailscale] = useState(false);
  const [expose, setExpose] = useState(false);
  const [pairAllowInput, setPairAllowInput] = useState(false);
  const [allowTranscript, setAllowTranscript] = useState(false);
  const [allowUpload, setAllowUpload] = useState(initialUpload);
  const [allowDangerousLaunch, setAllowDangerousLaunch] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const noop = vi.fn();
  const props: WebPopoverBodyProps = {
    info: running ? { running: true, host: '127.0.0.1', port: 7681, urls: ['http://127.0.0.1:7681/'] } : { running: false },
    allowInput,
    expose,
    tailscale,
    allowTranscript,
    allowUpload,
    allowDangerousLaunch,
    advancedOpen,
    onToggleAdvanced: () => setAdvancedOpen((v) => !v),
    busy: false,
    copied: null,
    deviceName: '',
    qr: null,
    onToggleAllowInput: () => setAllowInput((v) => !v),
    onToggleExpose: () => setExpose((v) => !v),
    onToggleTailscale: () => setTailscale((v) => !v),
    onToggleAllowTranscript: () => setAllowTranscript((v) => !v),
    onToggleAllowUpload: () => setAllowUpload((v) => !v),
    onToggleAllowDangerousLaunch: () => setAllowDangerousLaunch((v) => !v),
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
  it.each(['web.allowInput', 'web.tailscale', 'web.expose', 'web.allowTranscript', 'web.allowUpload'])('%s toggles from its label text', (key) => {
    act(() => root.render(createElement(Harness)));
    // Upload needs input on before it can be ticked.
    if (key === 'web.allowUpload') act(() => checkboxFor('web.allowInput').label.click());
    const { label, box } = checkboxFor(key);
    expect(box.getAttribute('aria-checked')).toBe('false');
    act(() => label.click());
    expect(box.getAttribute('aria-checked')).toBe('true');
    act(() => label.click());
    expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('Dangerous launch is reached through the Advanced disclosure and starts off', () => {
    act(() => root.render(createElement(Harness)));
    expect(Array.from(container.querySelectorAll('label')).some((l) => l.textContent === 'web.allowDangerousLaunch')).toBe(false);
    const disclosure = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'web.advanced');
    if (!disclosure) throw new Error('no Advanced disclosure');
    act(() => disclosure.click());
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    const { label, box } = checkboxFor('web.allowDangerousLaunch');
    expect(box.getAttribute('aria-checked')).toBe('false');
    act(() => label.click());
    expect(box.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles on Space and ignores Enter, like the native checkbox it replaced', () => {
    act(() => root.render(createElement(Harness)));
    const { box } = checkboxFor('web.allowInput');
    press(box, 'Enter');
    expect(box.getAttribute('aria-checked')).toBe('false');
    press(box, ' ');
    expect(box.getAttribute('aria-checked')).toBe('true');
  });

  it('the phone card asks View only or Can type, View only first, above the scope paragraph', () => {
    act(() => root.render(createElement(Harness, { running: true })));
    const group = container.querySelector('[data-testid="pair-access"]')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([['web.wizardViewOnly', 'true'], ['web.wizardRemoteControl', 'false']]);
    act(() => radios[1]!.click());
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    // Picking the chosen option again changes nothing.
    act(() => radios[1]!.click());
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
  });

  it('the one-click card asks it too while stopped, says what each allows, and never raises the server\'s input', () => {
    act(() => root.render(createElement(Harness)));
    const group = () => container.querySelector('[data-testid="pair-access"]')!;
    expect(group().nextElementSibling?.textContent).toBe('web.wizardViewOnlyHint');
    act(() => group().querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click());
    // This computer's input is off for the next Start, so Can type says so.
    expect(group().nextElementSibling?.textContent).toBe('web.pairInputOff');
    expect(checkboxFor('web.allowInput').box.getAttribute('aria-checked')).toBe('false');
    act(() => checkboxFor('web.allowInput').label.click());
    expect(group().nextElementSibling?.textContent).toBe('web.pairCanTypeHint');
  });

  it('Photo & file upload reads off and disabled, with the reason, while input is off', () => {
    act(() => root.render(createElement(Harness, { initialUpload: true })));
    const upload = checkboxFor('web.allowUpload');
    const reason = () => document.getElementById(upload.box.getAttribute('aria-describedby') ?? '')?.textContent;
    // Upload is on for the next start, but a device without input cannot use it.
    expect(upload.box.getAttribute('aria-checked')).toBe('false');
    expect(upload.box.disabled).toBe(true);
    expect(reason()).toBe('web.allowUploadNeedsInput');
    act(() => upload.label.click());
    expect(upload.box.getAttribute('aria-checked')).toBe('false');
    // Input on: the stored choice shows again and the row is live.
    act(() => checkboxFor('web.allowInput').label.click());
    expect(upload.box.getAttribute('aria-checked')).toBe('true');
    expect(upload.box.disabled).toBe(false);
    expect(reason()).toBe('web.allowUploadHint');
  });
});
