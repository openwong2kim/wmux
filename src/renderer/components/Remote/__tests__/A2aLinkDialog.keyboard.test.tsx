// @vitest-environment jsdom
//
// Keyboard behaviour of the cross-PC link dialog's pickers (#1960): the PC
// picker is a radio group (one Tab stop; arrows and Home/End move focus and
// select, wrapping), the pane list a listbox (one Tab stop; Up/Down and
// Home/End move focus; Enter/Space select through the button's own click).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, type ReactElement } from 'react';
import type { A2aExposedPane, A2aRemoteHostRecordV1 } from '../../../../shared/a2aRemote';
import { A2aLinkDialogView, type A2aLinkDialogViewProps } from '../A2aLinkDialog';
import { rankExposedPanes } from '../a2aLinkModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const roots: Array<{ root: Root; el: HTMLElement }> = [];
function render(ui: ReactElement): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  roots.push({ root, el });
  return document.body;
}
afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
});

const host = (n: number, name: string): A2aRemoteHostRecordV1 => ({
  v: 1, hostId: `${n}1111111-1111-4111-8111-111111111111`, name, addresses: [name.toLowerCase()], port: 45660,
  fingerprint256: 'AA', peerId: `p${n}`, createdAt: '',
});
const HOSTS = [host(1, 'DESK'), host(2, 'LAPTOP'), host(3, 'MINI')];
const pane = (id: string): A2aExposedPane => ({ kind: 'pane', workspaceId: 'ws', workspaceName: 'API', paneId: id, label: id });

function props(over: Partial<A2aLinkDialogViewProps> = {}): A2aLinkDialogViewProps {
  return {
    localKind: 'pane', localName: 'Web / w1-1', localRemote: null,
    hosts: HOSTS, hostId: HOSTS[0].hostId, onPickHost: () => undefined,
    panes: rankExposedPanes([pane('a'), pane('b'), pane('c')], null),
    panesError: null, selected: null, onPickPane: () => undefined,
    send: true, receive: true, onSend: () => undefined, onReceive: () => undefined,
    busy: false, outcome: null, onPropose: () => undefined, onClose: () => undefined, t,
    ...over,
  };
}

const radios = (body: HTMLElement) => [...body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const options = (body: HTMLElement) => [...body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const stops = (els: HTMLElement[]) => els.filter((el) => el.tabIndex === 0);
function press(el: HTMLElement, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}

describe('A2aLinkDialogView PC picker keyboard', () => {
  it('is one Tab stop: the selected PC, or the first when none is selected', () => {
    const body = render(createElement(A2aLinkDialogView, props({ hostId: HOSTS[1].hostId })));
    expect(stops(radios(body)).map((r) => r.textContent)).toEqual(['LAPTOP']);
    act(() => roots[0].root.render(createElement(A2aLinkDialogView, props({ hostId: null }))));
    expect(stops(radios(body)).map((r) => r.textContent)).toEqual(['DESK']);
  });

  it('arrows move focus and select, wrapping at both ends', () => {
    const onPickHost = vi.fn();
    const body = render(createElement(A2aLinkDialogView, props({ onPickHost })));
    const [desk, laptop, mini] = radios(body);
    desk.focus();
    expect(press(desk, 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(laptop);
    expect(onPickHost).toHaveBeenLastCalledWith(HOSTS[1].hostId);
    press(laptop, 'ArrowDown');
    expect(document.activeElement).toBe(mini);
    press(mini, 'ArrowRight');
    expect(document.activeElement).toBe(desk);
    expect(onPickHost).toHaveBeenLastCalledWith(HOSTS[0].hostId);
    press(desk, 'ArrowLeft');
    expect(document.activeElement).toBe(mini);
    expect(onPickHost).toHaveBeenLastCalledWith(HOSTS[2].hostId);
    press(mini, 'ArrowUp');
    expect(document.activeElement).toBe(laptop);
  });

  it('Home and End jump to the first and last PC', () => {
    const onPickHost = vi.fn();
    const body = render(createElement(A2aLinkDialogView, props({ hostId: HOSTS[1].hostId, onPickHost })));
    const [desk, laptop, mini] = radios(body);
    laptop.focus();
    press(laptop, 'End');
    expect(document.activeElement).toBe(mini);
    expect(onPickHost).toHaveBeenLastCalledWith(HOSTS[2].hostId);
    press(mini, 'Home');
    expect(document.activeElement).toBe(desk);
    expect(onPickHost).toHaveBeenLastCalledWith(HOSTS[0].hostId);
  });
});

describe('A2aLinkDialogView pane list keyboard', () => {
  it('is one Tab stop: the selected pane, or the first when none is selected', () => {
    const body = render(createElement(A2aLinkDialogView, props()));
    expect(stops(options(body)).map((o) => o.dataset.paneId)).toEqual(['a']);
    act(() => roots[0].root.render(createElement(A2aLinkDialogView, props({ selected: pane('c') }))));
    expect(stops(options(body)).map((o) => o.dataset.paneId)).toEqual(['c']);
  });

  it('Up/Down and Home/End move focus (and the Tab stop) without selecting', () => {
    const onPickPane = vi.fn();
    const body = render(createElement(A2aLinkDialogView, props({ onPickPane })));
    const [a, b, c] = options(body);
    act(() => a.focus());
    press(a, 'ArrowDown');
    expect(document.activeElement).toBe(b);
    expect(stops(options(body))).toEqual([b]);
    press(b, 'ArrowDown');
    press(c, 'ArrowDown');
    expect(document.activeElement).toBe(a);
    press(a, 'ArrowUp');
    expect(document.activeElement).toBe(c);
    press(c, 'Home');
    expect(document.activeElement).toBe(a);
    press(a, 'End');
    expect(document.activeElement).toBe(c);
    // Left/Right are not list keys.
    expect(press(c, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(c);
    expect(onPickPane).not.toHaveBeenCalled();
    expect(options(body).map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
  });

  it('Enter selects the focused pane through the button\'s own activation, once', () => {
    const onPickPane = vi.fn();
    const body = render(createElement(A2aLinkDialogView, props({ onPickPane })));
    const [a, b] = options(body);
    act(() => a.focus());
    press(a, 'ArrowDown');
    // jsdom does not turn Enter into a click; a browser does, for a button
    // whose keydown is not prevented. So: Enter is left alone here, and the
    // click it produces selects exactly once.
    expect(press(b, 'Enter').defaultPrevented).toBe(false);
    expect(press(b, ' ').defaultPrevented).toBe(false);
    expect(onPickPane).not.toHaveBeenCalled();
    act(() => b.click());
    expect(onPickPane).toHaveBeenCalledOnce();
    expect(onPickPane).toHaveBeenCalledWith(pane('b'));
    act(() => roots[0].root.render(createElement(A2aLinkDialogView, props({ onPickPane, selected: pane('b') }))));
    expect(options(body).map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });
});
