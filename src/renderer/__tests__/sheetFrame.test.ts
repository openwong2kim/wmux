// @vitest-environment jsdom
// @wmux-lane unit
// 'win32' here is only a data-platform attribute value on a jsdom document;
// the test reads the stylesheets and nothing from the OS.
//
// The sheet's frame margins and radius per window shape (DESIGN.md "Window:
// frame and sheet"). jsdom does not cascade stylesheets, so this resolves the
// shipped rules by hand: every top-level rule whose selector matches the sheet
// in a built DOM, ordered by specificity and then source order.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesDir = path.join(__dirname, '..', 'styles');
const css = fs.readdirSync(stylesDir).filter((name) => name.endsWith('.css'))
  .map((name) => fs.readFileSync(path.join(stylesDir, name), 'utf8')).join('\n');

type Specificity = [number, number, number];

/** Split a selector list on its top-level commas. */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out;
}

/**
 * Selectors Level 4 specificity: `:is()`, `:not()` and `:has()` count as their
 * most specific argument, `:where()` counts nothing, any other functional
 * pseudo-class counts as one class.
 */
function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  let s = '';
  for (let i = 0; i < selector.length; i += 1) {
    const fn = /^:(is|not|has|where|[\w-]+)\(/.exec(selector.slice(i));
    if (!fn || selector[i - 1] === ':') { s += selector[i]; continue; }
    let depth = 0;
    let j = i + fn[0].length - 1;
    for (; j < selector.length; j += 1) {
      if (selector[j] === '(') depth += 1;
      else if (selector[j] === ')' && --depth === 0) break;
    }
    const arg = selector.slice(i + fn[0].length, j);
    if (['is', 'not', 'has'].includes(fn[1])) {
      const max = splitList(arg).map(specificity).sort((a, b) => compare(b, a))[0];
      max.forEach((n, k) => { total[k] += n; });
    } else if (fn[1] !== 'where') {
      total[1] += 1;
    }
    s += ' ';
    i = j;
  }
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):[\w-]+/g) ?? []).length;
  const types = (s.replace(/\[[^\]]+\]/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
    + (s.match(/::[\w-]+/g) ?? []).length;
  return [total[0] + ids, total[1] + classes, total[2] + types];
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

function expandMargin(value: string): string[] {
  const parts = value.trim().split(/\s+(?![^(]*\))/);
  const [t, r = t, b = t, l = r] = parts;
  return [t, r, b, l];
}

interface Sheet { margin: Record<(typeof SIDES)[number], string>; radius: string; shadow: string; borderWidth: string; borderColor: string }

/** The resolved margin, radius and shadow of the sheet for one window shape. */
function resolveSheet(opts: { platform: string; corners?: 'round' | 'square'; maximized?: boolean; fullscreen?: boolean; sidebarRight?: boolean; glass?: boolean }): Sheet {
  const html = document.documentElement;
  for (const a of [...html.attributes]) html.removeAttribute(a.name);
  html.setAttribute('data-platform', opts.platform);
  if (opts.corners) html.setAttribute('data-window-corners', opts.corners);
  if (opts.maximized) html.setAttribute('data-maximized', '');
  if (opts.fullscreen) html.setAttribute('data-fullscreen', '');
  if (opts.glass) html.setAttribute('data-glass', 'light');
  document.body.innerHTML = `<div class="wmux-frame-row flex ${opts.sidebarRight ? 'flex-row-reverse' : ''}">`
    + `<div class="wmux-shell-body relative flex ${opts.sidebarRight ? 'flex-row-reverse' : ''}"></div></div>`;
  const sheet = document.querySelector('.wmux-shell-body') as HTMLElement;

  const hits: Array<{ spec: Specificity; order: number; decls: postcss.Declaration[] }> = [];
  let order = 0;
  postcss.parse(css).walkRules((rule) => {
    order += 1;
    if (rule.parent?.type !== 'root') return;
    const matching = rule.selectors.filter((sel) => {
      try { return sheet.matches(sel); } catch { return false; }
    });
    if (matching.length === 0) return;
    const spec = matching.map(specificity).sort((a, b) => compare(b, a))[0];
    const decls: postcss.Declaration[] = [];
    rule.each((node) => { if (node.type === 'decl') decls.push(node); });
    hits.push({ spec, order, decls });
  });
  hits.sort((a, b) => compare(a.spec, b.spec) || a.order - b.order);

  const out: Sheet = { margin: { top: '0', right: '0', bottom: '0', left: '0' }, radius: '0', shadow: 'none', borderWidth: '0', borderColor: '' };
  for (const hit of hits) {
    for (const d of hit.decls) {
      if (d.prop === 'margin') expandMargin(d.value).forEach((v, i) => { out.margin[SIDES[i]] = v; });
      const side = /^margin-(top|right|bottom|left)$/.exec(d.prop)?.[1] as (typeof SIDES)[number] | undefined;
      if (side) out.margin[side] = d.value.trim();
      if (d.prop === 'border-radius') out.radius = d.value.trim();
      if (d.prop === 'box-shadow') out.shadow = d.value.trim();
      if (d.prop === 'border') {
        out.borderWidth = d.value.trim().split(/\s+/)[0];
        out.borderColor = d.value.trim().split(/\s+(?![^(]*\))/).slice(2).join(' ');
      }
      if (d.prop === 'border-width') out.borderWidth = d.value.trim();
      if (d.prop === 'border-color') out.borderColor = d.value.trim();
    }
  }
  return out;
}

function compare(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const INSET = 'var(--sheet-inset)';
const RADIUS = 'var(--sheet-radius)';
const FLUSH = { top: '0', right: '0', bottom: '0', left: '0' };

describe('sheet frame per window shape', () => {
  it('sits flush with its radius kept in a round-cornered window (macOS, Windows 11)', () => {
    for (const platform of ['darwin', 'win32']) {
      for (const sidebarRight of [false, true]) {
        const s = resolveSheet({ platform, corners: 'round', sidebarRight });
        expect(s.margin, `${platform} right=${sidebarRight}`).toEqual(FLUSH);
        expect(s.radius).toBe(RADIUS);
      }
    }
  });

  it('keeps the inset away from the rail in a square-cornered window (Windows 10, Linux)', () => {
    for (const platform of ['win32', 'linux']) {
      expect(resolveSheet({ platform, corners: 'square' }).margin).toEqual({ top: '0', right: INSET, bottom: INSET, left: '0' });
      expect(resolveSheet({ platform, corners: 'square', sidebarRight: true }).margin).toEqual({ top: '0', right: '0', bottom: INSET, left: INSET });
      expect(resolveSheet({ platform, corners: 'square' }).radius).toBe(RADIUS);
    }
  });

  it('fills a maximized Windows window, keeping the corner beside the rail and the titlebar round', () => {
    for (const corners of ['round', 'square'] as const) {
      const left = resolveSheet({ platform: 'win32', corners, maximized: true });
      expect(left.margin, corners).toEqual(FLUSH);
      expect(left.radius).toBe(`${RADIUS} 0 0 0`);
      // The hairline runs along the top and the rail side, never the screen's edges.
      expect(left.borderWidth).toBe('1px 0 0 1px');
      expect(left.shadow).toBe('var(--sheet-shadow)');
      const right = resolveSheet({ platform: 'win32', corners, maximized: true, sidebarRight: true });
      expect(right.margin, `${corners} right`).toEqual(FLUSH);
      expect(right.radius).toBe(`0 ${RADIUS} 0 0`);
      expect(right.borderWidth).toBe('1px 1px 0 0');
    }
  });

  it('fills the window in fullscreen even while a Windows window is also maximized', () => {
    for (const sidebarRight of [false, true]) {
      const s = resolveSheet({ platform: 'win32', corners: 'round', maximized: true, fullscreen: true, sidebarRight });
      expect(s.margin).toEqual(FLUSH);
      expect(s.radius).toBe('0');
      expect(s.borderWidth).toBe('1px 0 0');
    }
  });

  it('draws the sheet edge as an ink over the frame under window glass, an opaque token without it', () => {
    expect(resolveSheet({ platform: 'win32', corners: 'round' }).borderColor).toBe('var(--sheet-edge)');
    for (const platform of ['win32', 'darwin']) {
      for (const maximized of [false, true]) {
        expect(resolveSheet({ platform, corners: 'round', maximized, glass: true }).borderColor, `${platform} max=${maximized}`)
          .toBe('color-mix(in srgb, var(--text-main) 10%, transparent)');
      }
    }
  });

  it('leaves a maximized macOS or Linux window as its corners say', () => {
    expect(resolveSheet({ platform: 'darwin', corners: 'round', maximized: true }).radius).toBe(RADIUS);
    expect(resolveSheet({ platform: 'linux', corners: 'square', maximized: true }).margin.right).toBe(INSET);
  });

  it('fills the window in native fullscreen on any platform, sidebar on either side', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const sidebarRight of [false, true]) {
        const corners = platform === 'linux' ? 'square' : 'round';
        const s = resolveSheet({ platform, corners, fullscreen: true, sidebarRight });
        expect(s.margin, `${platform} right=${sidebarRight}`).toEqual(FLUSH);
        expect(s.radius).toBe('0');
      }
    }
  });

  it('counts :not() and :is() as their most specific argument', () => {
    expect(specificity('html[data-platform="win32"][data-maximized]:not([data-fullscreen]) .wmux-frame-row > .wmux-shell-body')).toEqual([0, 5, 1]);
    expect(specificity(':root:is([data-theme="a"], #b)')).toEqual([1, 1, 0]);
    expect(specificity('html:where(.a) .b')).toEqual([0, 1, 1]);
  });

  it('keys the flush rule on the corners attribute, not on the platform', () => {
    // A Windows 11 window and a macOS one resolve the same way, and nothing
    // keys the sheet margin on data-platform="darwin" any more.
    expect(css).not.toMatch(/data-platform="darwin"\][^{]*wmux-shell-body/);
  });
});
