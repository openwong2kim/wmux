// In an opaque window the pane column clips square and draws its rounded edge
// over the panes: on macOS a rounded clip with differing corners makes Chromium
// mask the whole column in window-sized GPU surfaces. Under window glass the
// column clips along x only when both sidebar-side corner panes are plain
// terminals, which then round their own boxes. Compositing does not run in
// jsdom, so this reads the stylesheet.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const OPAQUE = 'html:not([data-glass]) .wmux-shell-body:not([data-sidebar="hidden"]) .wmux-main-column';

/** The selectors of a selector list (commas inside parentheses do not split). */
function selectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  out.push(list.slice(start).trim());
  return out;
}
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: selectorList(m[1]), body: m[2] }));

/** Declarations of every rule whose selector list includes `selector`. */
function rules(selector: string): string[] {
  return RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.body);
}

describe('pane column edge in an opaque window', () => {
  it('clips square and keeps the curve in non-interactive overlays', () => {
    expect(rules(OPAQUE).join(';')).toMatch(/border-radius:\s*0\s*;/);
    const overlay = rules(`${OPAQUE}::after`).join(';');
    expect(overlay).toMatch(/border-radius:\s*var\(--sheet-radius\) 0 0 var\(--sheet-radius\)/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
  });

  it('under glass, clips along x only and rounds corner boxes, only behind the both-corners gate', () => {
    const cornerRules = RULES.flatMap((r) => r.selectors).filter((x) => x.includes('[data-corner'));
    expect(cornerRules.length).toBeGreaterThan(0);
    for (const sel of cornerRules) {
      expect(sel.startsWith('html[data-glass] ')).toBe(true);
      const right = /\.flex-row-reverse(?!\))/.test(sel);
      for (const c of right ? ['tr', 'br'] : ['tl', 'bl']) expect(sel).toContain(`:has([data-pane-grid-wrapper="shown"] [data-corner~="${c}"])`);
    }
    const unclipped = RULES.filter((r) => r.selectors.some((x) => x.endsWith('.wmux-main-column') || x.includes('.wmux-main-column:')) && /overflow:\s*visible/.test(r.body));
    expect(unclipped.length).toBe(1);
    expect(unclipped[0].body).toMatch(/overflow-x:\s*clip/);
    expect(unclipped[0].selectors.length).toBe(2);
    for (const r of unclipped[0].selectors) expect(r).toMatch(/^html\[data-glass\] .*:has\(\[data-pane-grid-wrapper="shown"\] \[data-corner~=.*\]\):has\(.*\):not\(:has\(.*\)\)$/);
  });
});
