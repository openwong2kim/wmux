// In an opaque window the pane column clips square and draws its rounded edge
// over the panes: on macOS a rounded clip with differing corners makes Chromium
// mask the whole column in window-sized GPU surfaces. Compositing does not run
// in jsdom, so this reads the stylesheet.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const OPAQUE = 'html:not([data-glass]) .wmux-shell-body:not([data-sidebar="hidden"]) .wmux-main-column';

/** Declarations of every rule whose selector list is exactly `selector`. */
function rules(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim() === selector) out.push(m[2]);
  }
  return out;
}

describe('pane column edge in an opaque window', () => {
  it('clips square and keeps the curve in non-interactive overlays', () => {
    expect(rules(OPAQUE).join(';')).toMatch(/border-radius:\s*0\s*;/);
    const overlay = rules(`${OPAQUE}::before,\n${OPAQUE}::after`).join(';');
    expect(overlay).toMatch(/border-radius:\s*var\(--sheet-radius\) 0 0 var\(--sheet-radius\)/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
  });
});
