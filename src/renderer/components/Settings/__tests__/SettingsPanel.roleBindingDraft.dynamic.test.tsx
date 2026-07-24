// @vitest-environment jsdom
//
// P2-A — typing into the role-binding text fields.
//
// The fields are controlled from the store, and every write is normalized on the
// way in (normalizeBindingField collapses whitespace runs and trims). So the
// space in `--foo ` was eaten the instant it was typed, the field re-rendered as
// `--foo`, and the next character landed as `--foob`: a two-token args value
// could be pasted but never typed.
//
// These mount the REAL editor against the REAL store, so the normalization under
// test is the one that ships — a hand-rolled onChange would not reproduce the
// bug. Typing is character-by-character, reading `input.value` back each time,
// because "what the next keystroke appends to" is the whole mechanic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RoleBindingsView } from '../SettingsPanel';
import { t as translate } from '../../../i18n';
import { useStore } from '../../../stores';

/** The editor exactly as SettingsPanel wires it (store in, store out). */
function RoleBindingEditorHarness() {
  const bindings = useStore((s) => s.orchestratorRoleBindings);
  const setBinding = useStore((s) => s.setOrchestratorRoleBinding);
  return createElement(RoleBindingsView, { bindings, onChange: setBinding, t: translate });
}

let container: HTMLDivElement;
let root: Root;

// React only treats act() as authoritative when this is set; without it every
// act() call warns on stderr.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** React delegates onBlur from the native `focusout` (plain `blur` does not
 *  bubble, so it never reaches the root listener). */
function blur(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/** React tracks an input's value on the node itself, so a plain assignment is
 *  swallowed as "no change". Write through the prototype setter the way a real
 *  keystroke does. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}

/** Type `text` one character at a time, each appended to whatever the field is
 *  currently SHOWING — the exact loop a person's fingers perform. */
function typeInto(input: HTMLInputElement, text: string): void {
  for (const ch of text) {
    const next = input.value + ch;
    act(() => {
      setNativeValue(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

function paste(input: HTMLInputElement, text: string): void {
  act(() => {
    setNativeValue(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const field = (label: string): HTMLInputElement => {
  const el = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw new Error(`no field labelled ${label}`);
  return el;
};

const stored = (role: string) => useStore.getState().orchestratorRoleBindings[role];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ orchestratorRoleBindings: {} }));
  act(() => root.render(createElement(RoleBindingEditorHarness)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ orchestratorRoleBindings: {} }));
});

describe('role-binding args field — a multi-token value can be TYPED', () => {
  it('keeps every character of a two-token value typed one key at a time', () => {
    const args = field('Builder extra args');
    typeInto(args, '--permission-mode plan');
    // The bug: the space vanished on its keystroke and `plan` fused onto the
    // flag, giving `--permission-modeplan`.
    expect(args.value).toBe('--permission-mode plan');
    expect(stored('Builder')?.args).toBe('--permission-mode plan');
  });

  it('shows the trailing space while it is being typed', () => {
    const args = field('Builder extra args');
    typeInto(args, '--foo ');
    expect(args.value).toBe('--foo ');
    // ...and the PERSISTED value is normalized all the same.
    expect(stored('Builder')?.args).toBe('--foo');
  });

  it('normalizes the displayed value on blur', () => {
    const args = field('Builder extra args');
    typeInto(args, '--foo  ');
    blur(args);
    expect(args.value).toBe('--foo');
    expect(stored('Builder')?.args).toBe('--foo');
  });

  it('normalizes the displayed value on Enter', () => {
    const args = field('Reviewer extra args');
    typeInto(args, '--verbose ');
    act(() => {
      args.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(args.value).toBe('--verbose');
    expect(stored('Reviewer')?.args).toBe('--verbose');
  });

  it('persists a pasted value, normalized', () => {
    const args = field('Tester extra args');
    paste(args, '  --permission-mode   plan  ');
    expect(stored('Tester')?.args).toBe('--permission-mode plan');
  });

  it('survives an unmount mid-edit — every keystroke is already committed', () => {
    const args = field('Planner extra args');
    typeInto(args, '--foo bar');
    act(() => root.unmount());
    expect(stored('Planner')?.args).toBe('--foo bar');
  });

  it('does not leak one role’s draft into another row', () => {
    typeInto(field('Builder extra args'), '--a ');
    typeInto(field('Reviewer extra args'), '--b ');
    expect(field('Builder extra args').value).toBe('--a ');
    expect(field('Reviewer extra args').value).toBe('--b ');
    expect(stored('Builder')?.args).toBe('--a');
    expect(stored('Reviewer')?.args).toBe('--b');
  });

  it('leaves the other fields of the row alone while args are typed', () => {
    act(() =>
      useStore.getState().setOrchestratorRoleBinding('Builder', { agent: 'claude', model: 'haiku' }),
    );
    typeInto(field('Builder extra args'), '--x');
    expect(stored('Builder')).toEqual({ agent: 'claude', model: 'haiku', args: '--x' });
  });
});

describe('role-binding model field — same draft, same normalization', () => {
  it('types a model id through unchanged', () => {
    const model = field('Reviewer model');
    typeInto(model, 'gpt-5.5');
    expect(model.value).toBe('gpt-5.5');
    expect(stored('Reviewer')?.model).toBe('gpt-5.5');
  });

  it('keeps a typed space visible even though the store refuses it', () => {
    // A model must be ONE token (MODEL_TOKEN_RE), so `a b` is rejected outright.
    // The field still shows what was typed instead of silently swallowing keys.
    const model = field('Tester model');
    typeInto(model, 'a b');
    expect(model.value).toBe('a b');
    expect(stored('Tester')?.model).toBeUndefined();
  });
});
