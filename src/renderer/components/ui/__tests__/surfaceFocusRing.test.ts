// Inputs inside a quiet surface (dialogs, popovers) keep the steel focus ring.
//
// `.ui-surface .ui-input` flattens the recessed input and ties `.ui-input:focus`
// on specificity (two classes each). Declared later, it used to win and strip
// the ring's border and box-shadow, with `outline: none` already set — so a
// keyboard user could not see which field had focus. jsdom does not resolve
// :focus against the cascade, so this pins the rule order in the source.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Normalize line endings: a Windows checkout reads ui.css with CRLF, and the
// selectors below are matched with '\n'.
const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'ui.css'), 'utf8').replace(/\r\n/g, '\n');

function ruleAt(selector: string): { index: number; body: string } {
  const index = css.indexOf(selector);
  expect(index, `${selector} not found in ui.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  return { index, body: css.slice(open, css.indexOf('}', open)) };
}

describe('surface inputs keep the focus ring', () => {
  const flat = ruleAt('.ui-surface .ui-input,\n.ui-surface .ui-select > select {');

  it.each([
    '.ui-surface .ui-input:focus,',
    '.ui-surface .ui-input:focus-visible,',
    '.ui-surface .ui-select > select:focus-visible',
  ])('%s is declared after the flat surface rule and paints the steel ring', (selector) => {
    const focus = ruleAt(selector);
    expect(focus.index).toBeGreaterThan(flat.index);
    expect(focus.body).toContain('border-color: var(--accent-blue)');
    expect(focus.body).toMatch(/box-shadow:[^;]*var\(--accent-blue\)/);
  });
});
