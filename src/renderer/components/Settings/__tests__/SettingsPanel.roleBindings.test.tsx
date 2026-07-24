/**
 * D2 — the Settings › Orchestrator role→model editor.
 *
 * Two halves, mirroring the SettingsPanel.notifications pattern:
 *   1. `roleBindingHint` as a pure function — the honesty rule that keeps a row
 *      from looking bound while enforcing nothing.
 *   2. `RoleBindingsView` through `renderToStaticMarkup` (the repo's vitest
 *      config is node-env) — focus rings, the border token, the model combobox,
 *      i18n'd aria-labels, and the change plumbing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoleBindingsView, roleBindingHint, type RoleBindingsViewProps } from '../SettingsPanel';
import { t as translate } from '../../../i18n';
import { FOCUS_RING } from '../../focusRing';

describe('roleBindingHint — a row never lies about what it enforces (P2-4)', () => {
  it('flags a model with no agent', () => {
    expect(roleBindingHint({ model: 'haiku' })?.key).toBe('settings.roleBindingHintNoAgent');
  });

  it('flags an agent whose --model grammar wmux has not verified', () => {
    const hint = roleBindingHint({ agent: 'opencode', model: 'x' });
    expect(hint?.key).toBe('settings.roleBindingHintNoGrammar');
    expect(hint?.params).toEqual({ agent: 'opencode' });
  });

  it('flags an inert row — an agent with nothing to enforce', () => {
    expect(roleBindingHint({ agent: 'claude' })?.key).toBe('settings.roleBindingHintInert');
  });

  it('is silent for a fully valid binding', () => {
    expect(roleBindingHint({ agent: 'claude', model: 'haiku' })).toBeUndefined();
    expect(roleBindingHint({ agent: 'codex', model: 'gpt-5.5', args: '--verbose' })).toBeUndefined();
    expect(roleBindingHint({ agent: 'opencode', args: '--verbose' })).toBeUndefined();
    expect(roleBindingHint({})).toBeUndefined();
  });
});

describe('RoleBindingsView render', () => {
  const render = (
    bindings: RoleBindingsViewProps['bindings'] = {},
    onChange: RoleBindingsViewProps['onChange'] = () => undefined,
  ): string =>
    renderToStaticMarkup(
      createElement(RoleBindingsView, { bindings, onChange, t: translate }),
    );

  // P2-9 — the 12 new controls had `outline-none` and no ring, so keyboard
  // focus vanished inside this block.
  it('gives every control a focus ring', () => {
    const html = render();
    const ringToken = 'focus-visible:ring-2';
    expect(FOCUS_RING).toContain(ringToken);
    // 4 roles × (agent select + model input + args input).
    expect(html.split(ringToken).length - 1).toBe(12);
  });

  // P2-9 — --bg-overlay is a BACKGROUND token; borders use the hairline token.
  it('uses the border token, not a background token, for the field hairline', () => {
    const html = render();
    expect(html).toContain('border-[color:var(--border-soft)]');
    expect(html).not.toContain('1px solid var(--bg-overlay)');
  });

  // P2-4 — a <select> of Claude aliases could not express a valid codex model.
  it('renders the model field as a free-text combobox with a datalist', () => {
    const html = render();
    expect(html).toContain('<datalist id="role-binding-models-Builder">');
    expect(html).toContain('list="role-binding-models-Builder"');
  });

  it('suggests claude aliases only when the row is bound to claude', () => {
    expect(render({ Builder: { agent: 'claude' } })).toContain('Haiku 4.5');
    expect(render({ Builder: { agent: 'codex' } })).not.toContain('Haiku 4.5');
  });

  it('keeps a typed codex model id in the field (free text, not a fixed list)', () => {
    expect(render({ Reviewer: { agent: 'codex', model: 'gpt-5.5' } })).toContain('value="gpt-5.5"');
  });

  // P2-10 — the aria-labels were hardcoded English template literals.
  it('routes aria-labels through t()', () => {
    const html = render();
    // en.ts interpolates {role}; a missing key would surface the raw key.
    expect(html).toContain('aria-label="Builder agent"');
    expect(html).toContain('aria-label="Builder model"');
    expect(html).toContain('aria-label="Builder extra args"');
    expect(html).not.toContain('settings.roleBindingAgentLabel');
  });

  it('shows the inline hint on a row that cannot enforce what it shows', () => {
    const html = render({ Reviewer: { model: 'haiku' } });
    expect(html).toContain('data-role-binding-hint="Reviewer"');
    expect(html).toContain('Pick an agent too');
  });

  it('names the agent in the no-grammar hint', () => {
    expect(render({ Tester: { agent: 'gemini', model: 'flash' } })).toContain(
      'no verified --model flag for gemini',
    );
  });

  it('shows no hint for a valid binding', () => {
    expect(render({ Reviewer: { agent: 'codex', model: 'gpt-5.5' } })).not.toContain(
      'data-role-binding-hint',
    );
  });

  it('merges a per-field edit onto the role’s existing binding', () => {
    const onChange = vi.fn();
    // The view is hook-free, so call it and drive the real onChange handler —
    // renderToStaticMarkup drops handlers, and the merge is the interesting part
    // (editing one field must not clear the other two).
    const tree = RoleBindingsView({
      bindings: { Builder: { agent: 'claude', args: '--verbose' } },
      onChange,
      t: translate,
    });
    const modelInput = findByAriaLabel(tree, 'Builder model');
    expect(modelInput).toBeDefined();
    modelInput?.props.onChange({ target: { value: 'haiku' } });
    expect(onChange).toHaveBeenCalledWith('Builder', {
      agent: 'claude',
      args: '--verbose',
      model: 'haiku',
    });
  });
});

type Handled = ReactElement<{
  'aria-label'?: string;
  children?: unknown;
  onChange: (e: { target: { value: string } }) => void;
}>;

/** Depth-first search of a rendered element tree for a node by aria-label. */
function findByAriaLabel(node: unknown, label: string): Handled | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByAriaLabel(child, label);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as { 'aria-label'?: string; children?: unknown };
  if (props['aria-label'] === label) return node as Handled;
  return findByAriaLabel(props.children, label);
}
