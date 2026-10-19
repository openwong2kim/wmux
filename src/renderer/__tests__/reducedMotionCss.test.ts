import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Every `@media (prefers-reduced-motion: reduce)` rule in the renderer has a
// `:root[data-reduced-motion]` twin for each of its selectors: Windows'
// Animation effects off reaches the renderer only as that root attribute
// (utils/reducedMotion.ts), so a rule without its twin is inert there.

const HEAD = '@media (prefers-reduced-motion: reduce) {';
const ROOT = path.resolve(__dirname, '..');

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

/** The selectors inside each reduced-motion media block of `css`. */
function reducedMotionSelectors(css: string): string[] {
  const out: string[] = [];
  for (let i = css.indexOf(HEAD); i >= 0; i = css.indexOf(HEAD, i + 1)) {
    let k = i + HEAD.length;
    for (let depth = 1; depth > 0; k++) depth += css[k] === '{' ? 1 : css[k] === '}' ? -1 : 0;
    const inner = css.slice(i + HEAD.length, k - 1).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of inner.matchAll(/([^{}]+)\{[^{}]*\}/g)) out.push(...m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')));
  }
  return out;
}

describe('reduced-motion CSS honours the Windows root attribute', () => {
  const files = cssFiles(ROOT).filter((f) => fs.readFileSync(f, 'utf8').includes(HEAD));

  it('finds the reduced-motion rules', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${path.relative(ROOT, file)}: each reduced-motion selector has a :root[data-reduced-motion] twin`, () => {
      const css = fs.readFileSync(file, 'utf8');
      const flat = css.replace(/\s+/g, ' ');
      const missing = reducedMotionSelectors(css).filter((sel) => !flat.includes(`:root[data-reduced-motion] ${sel}`));
      expect(missing).toEqual([]);
    });
  }
});
