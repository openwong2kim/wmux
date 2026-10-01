// @vitest-environment jsdom
//
// The role-binding model combobox: opening shows the WHOLE discovered list
// (the native datalist it replaced showed only the current value), typing
// filters, picking commits, and free text is committed per keystroke.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelCombobox } from '../ModelCombobox';
import { effortChoicesFor } from '../SettingsPanel';
import type { CatalogModel } from '../../../../shared/modelCatalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODELS: CatalogModel[] = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
];

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

function mount(value: string, onChange = vi.fn()) {
  act(() => {
    root.render(createElement(ModelCombobox, { value, onChange, models: MODELS, 'aria-label': 'Builder model' }));
  });
  return { input: container.querySelector('input') as HTMLInputElement, onChange };
}

const options = () => Array.from(container.querySelectorAll('[role="option"]')) as HTMLButtonElement[];

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ModelCombobox', () => {
  it('opens the full list even when a value is already chosen', () => {
    const { input } = mount('gemini-3.8-flash-low');
    act(() => input.focus());
    expect(options()).toHaveLength(3);
    expect(options().find((o) => o.getAttribute('aria-selected') === 'true')?.textContent).toContain(
      'gemini-3.8-flash-low',
    );
  });

  it('filters by id or label while typing and commits each keystroke', () => {
    const { input, onChange } = mount('');
    act(() => input.focus());
    type(input, 'sonnet');
    expect(options()).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith('sonnet');
  });

  it('commits the picked id on click, keeping focus in the field on mousedown', () => {
    const { input, onChange } = mount('');
    act(() => input.focus());
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      options()[0].dispatchEvent(down);
    });
    // mousedown alone neither commits nor blurs (so the list survives to the click).
    expect(down.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      options()[0].click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('gemini-3.8-flash-high');
    expect(listbox()).toBeNull();
  });
});

const listbox = () => container.querySelector('[role="listbox"]');

function key(input: HTMLInputElement, k: string) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => {
    input.dispatchEvent(ev);
  });
  return ev;
}

describe('ModelCombobox keyboard', () => {
  it('arrows move an active option, wrapping, tracked by aria-activedescendant', () => {
    const { input } = mount('');
    act(() => input.focus());
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(input.getAttribute('aria-controls')).toBe(listbox()?.id);

    expect(key(input, 'ArrowDown').defaultPrevented).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(options()[0].id).not.toBe('');
    key(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    key(input, 'ArrowUp');
    key(input, 'ArrowUp'); // wraps from the first to the last
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    expect(options()[2].getAttribute('data-active')).toBe('true');
  });

  it('Enter commits the active option and closes the list', () => {
    const { input, onChange } = mount('');
    act(() => input.focus());
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('gemini-3.8-flash-low');
    expect(listbox()).toBeNull();
  });

  it('Enter with no active option keeps the typed text', () => {
    const { input, onChange } = mount('');
    act(() => input.focus());
    type(input, 'my-own-model');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('my-own-model');
    expect(listbox()).toBeNull();
  });

  it('filters, then arrows within the filtered list', () => {
    const { input, onChange } = mount('');
    act(() => input.focus());
    type(input, 'gemini');
    expect(options()).toHaveLength(2);
    key(input, 'ArrowUp');
    key(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('gemini-3.8-flash-low');
  });

  it('ArrowDown reopens a closed list', () => {
    const { input } = mount('');
    act(() => input.focus());
    key(input, 'Escape');
    expect(listbox()).toBeNull();
    key(input, 'ArrowDown');
    expect(listbox()).not.toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  it('Escape closes the open list', () => {
    const { input } = mount('');
    act(() => input.focus());
    key(input, 'Escape');
    expect(listbox()).toBeNull();
  });

  it('options are not tab stops, and tabbing away closes the list', () => {
    const { input } = mount('');
    act(() => input.focus());
    expect(options().every((o) => o.tabIndex === -1)).toBe(true);
    act(() => input.blur());
    expect(listbox()).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('effortChoicesFor', () => {
  it('lists agy effort suffixes of the chosen family only', () => {
    expect(effortChoicesFor({ agent: 'agy', model: 'gemini-3.8-flash-low' }, MODELS)).toEqual(['high', 'low']);
    expect(effortChoicesFor({ agent: 'agy', model: 'claude-sonnet-4-6' }, MODELS)).toEqual([]);
  });

  it('uses the codex model\'s reported levels', () => {
    const codex: CatalogModel[] = [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium'] }];
    expect(effortChoicesFor({ agent: 'codex', model: 'gpt-5.5' }, codex)).toEqual(['low', 'medium']);
  });

  it('offers claude its fixed levels and nothing for other agents', () => {
    expect(effortChoicesFor({ agent: 'claude' }, [])).toContain('max');
    expect(effortChoicesFor({ agent: 'opencode' }, [])).toEqual([]);
  });
});
