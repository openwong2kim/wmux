// @vitest-environment jsdom
//
// Switch, Checkbox, SegmentedControl and Field: the ARIA roles and keyboard
// contracts that the native controls they replace gave for free.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Switch from '../Switch';
import Checkbox from '../Checkbox';
import Field from '../Field';
import Select from '../Select';
import SegmentedControl from '../SegmentedControl';
import Badge from '../Badge';

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

const press = (el: Element, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};

function Controlled({ kind, disabled }: { kind: 'switch' | 'checkbox'; disabled?: boolean }) {
  const [on, setOn] = useState(false);
  const C = kind === 'switch' ? Switch : Checkbox;
  return createElement(
    Field,
    { label: 'Sound', description: 'Play a chime' },
    createElement(C, { checked: on, onCheckedChange: setOn, disabled }),
  );
}

describe.each(['switch', 'checkbox'] as const)('%s', (kind) => {
  const control = () => container.querySelector(`[role="${kind}"]`) as HTMLButtonElement;

  it('exposes its role and state, labelled and described by the Field', () => {
    act(() => root.render(createElement(Controlled, { kind })));
    const el = control();
    expect(el.getAttribute('aria-checked')).toBe('false');
    const label = container.querySelector(`label[for="${el.id}"]`);
    expect(label?.textContent).toBe('Sound');
    expect(document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Play a chime');
  });

  it('toggles on click and on Space', () => {
    act(() => root.render(createElement(Controlled, { kind })));
    act(() => control().click());
    expect(control().getAttribute('aria-checked')).toBe('true');
    const e = press(control(), ' ');
    expect(e.defaultPrevented).toBe(true);
    expect(control().getAttribute('aria-checked')).toBe('false');
  });

  it('does nothing while disabled', () => {
    act(() => root.render(createElement(Controlled, { kind, disabled: true })));
    act(() => control().click());
    press(control(), ' ');
    expect(control().getAttribute('aria-checked')).toBe('false');
  });
});

describe('Enter', () => {
  it('toggles a switch but not a checkbox (native checkbox behaviour)', () => {
    act(() => root.render(createElement('div', null, createElement(Controlled, { kind: 'switch' }), createElement(Controlled, { kind: 'checkbox' }))));
    const sw = container.querySelector('[role="switch"]') as HTMLElement;
    const cb = container.querySelector('[role="checkbox"]') as HTMLElement;
    press(sw, 'Enter');
    press(cb, 'Enter');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(cb.getAttribute('aria-checked')).toBe('false');
  });
});

describe('SegmentedControl', () => {
  function Harness() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a');
    return createElement(SegmentedControl<'a' | 'b' | 'c'>, {
      value: v,
      onValueChange: setV,
      ariaLabel: 'Density',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', disabled: true },
        { value: 'c', label: 'C' },
      ],
    });
  }
  const radios = () => Array.from(container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];

  it('is a named radio group with a single tab stop on the selected segment', () => {
    act(() => root.render(createElement(Harness)));
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Density');
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('arrow keys move and select, skipping disabled segments and wrapping', () => {
    act(() => root.render(createElement(Harness)));
    radios()[0].focus();
    press(radios()[0], 'ArrowRight');
    expect(radios()[2].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios()[2]);
    press(radios()[2], 'ArrowRight');
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');
    press(radios()[0], 'End');
    expect(radios()[2].getAttribute('aria-checked')).toBe('true');
  });
});

describe('Select and Badge', () => {
  it('Select is a native select wired to its Field', () => {
    act(() =>
      root.render(
        createElement(Field, { label: 'Shell', layout: 'stacked' },
          createElement(Select, { defaultValue: 'zsh' }, createElement('option', { value: 'zsh' }, 'zsh'))),
      ),
    );
    const sel = container.querySelector('select') as HTMLSelectElement;
    expect(container.querySelector(`label[for="${sel.id}"]`)?.textContent).toBe('Shell');
    expect(sel.hasAttribute('aria-describedby')).toBe(false);
  });

  it('Badge defaults to the neutral tone', () => {
    act(() => root.render(createElement(Badge, null, 'Beta')));
    expect(container.querySelector('.ui-badge')?.getAttribute('data-tone')).toBe('neutral');
  });
});
