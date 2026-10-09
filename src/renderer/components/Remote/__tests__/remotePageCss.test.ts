// A size container never matches its own container query: an unnamed
// `@container` rule asks the nearest ANCESTOR container. So a rule inside one
// that styles the container itself never applies. The Remote page fell into
// this: its 14px narrow sides never took effect. Container queries do not run
// in jsdom, so these read the stylesheet.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the block whose `{` is at `open`, without the braces. */
function blockAt(open: number): string {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

/** Single-class selectors that make an element a size container. */
function containers(): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/(^|[}\s])(\.[\w-]+)\s*\{([^{}]*)\}/g)) {
    if (/container-type\s*:\s*(inline-size|size)/.test(m[3])) out.add(m[2]);
  }
  return out;
}

/** Every top-level selector inside unnamed `@container (…)` blocks. */
function unnamedQuerySelectors(): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@container\s*\(/g)) {
    const body = blockAt(css.indexOf('{', m.index));
    for (const r of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      out.push(...r[1].split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

describe('container queries', () => {
  it('no unnamed @container rule styles a size container itself', () => {
    const own = containers();
    expect(own.size).toBeGreaterThan(0);
    const selfStyled = unnamedQuerySelectors().filter((s) => own.has(s));
    expect(selfStyled).toEqual([]);
  });

  it('a nested link row keeps its actions on its own line (no implicit `acts` track)', () => {
    // `.wmux-remote-acts` names the `acts` area of a PC row; a nested link row
    // defines no areas, so the name would open an implicit track and drop
    // Unlink / Open onto a row of its own.
    expect(css).toMatch(/\.wmux-remote-acts\s*\{[^}]*grid-area:\s*acts/);
    expect(css).not.toMatch(/\.wmux-remote-link\s*\{[^}]*grid-template-areas/);
    expect(css).toMatch(/\.wmux-remote-link\s*>\s*\.wmux-remote-acts\s*\{[^}]*grid-area:\s*auto/);
  });

  it('the Remote page takes its 14px narrow sides from the rail page around it', () => {
    expect(containers().has('.wmux-remote-page')).toBe(false);
    expect(css).toMatch(/\.wmux-page\[data-rail-page="remote"\]\s*\{[^}]*container-type:\s*inline-size/);
    expect(unnamedQuerySelectors()).toContain('.wmux-remote-page');
  });
});
