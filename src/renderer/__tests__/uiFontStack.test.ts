/**
 * The UI type stack, asserted at its source of truth rather than at a build
 * artifact. `dist/` is gitignored and is not produced by the test run, so a
 * test that read the compiled CSS would pass or fail depending on whether
 * someone happened to have run a build — these three inputs are what the build
 * compiles, so pinning them pins the output.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'globals.css'), 'utf8');

/** Every @font-face block that declares font-family: 'Inter'. */
function interFaces(): string[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((body) => /font-family:\s*'Inter'/.test(body));
}

describe('UI font stack', () => {
  it('bundles Inter as two subsets', () => {
    expect(interFaces()).toHaveLength(2);
  });

  it('declares the full 100..900 weight axis, not the 400..600 design range', () => {
    // A variable font is clamped to the range its @font-face advertises, and
    // Chromium does not synthesise bold past it. Declaring 400..600 would have
    // flattened every font-bold / fontWeight:700 in the renderer to 600 and
    // erased DESIGN.md's "Orchestrator = main 700 vs You = muted 600" speaker
    // hierarchy. The bundled files are byte-identical to what Google serves for
    // wght@100..900, so the axis is really there.
    for (const body of interFaces()) {
      expect(body).toMatch(/font-weight:\s*100 900;/);
    }
  });

  it('does not duplicate combining marks across both subsets', () => {
    // When two faces of one family both cover a codepoint the LATER @font-face
    // wins, so a mark left in latin-ext pulls its 85 KB file for a single stray
    // accent even though the already-loaded latin file has the glyph.
    const [latin, latinExt] = interFaces();
    for (const mark of ['U+0304', 'U+0308', 'U+0329']) {
      expect(latin, `${mark} stays in latin`).toContain(mark);
      expect(latinExt, `${mark} is dropped from latin-ext`).not.toContain(mark);
    }
  });

  it('leads the --font-ui stack with Inter and keeps a system fallback behind it', () => {
    const decl = /--font-ui:\s*([^;]+);/.exec(css);
    expect(decl).not.toBeNull();
    const families = (decl as RegExpExecArray)[1].split(',').map((f) => f.trim());
    expect(families[0]).toBe('Inter');
    // Nothing may be inserted ahead of Inter — in particular no Hangul face.
    // Inter carries no Hangul, so a ko UI resolves Latin runs to Inter and
    // Hangul runs to the platform's system UI face, which is the intent. A
    // Hangul family placed FIRST would capture the Latin runs too.
    expect(families).toContain('system-ui');
    expect(families.join(',')).not.toMatch(/Hangul|Gothic|Malgun|Apple SD/i);
  });

  it('routes html/body through the token instead of re-typing the stack', () => {
    expect(css).toMatch(/html, body, #root \{[^}]*font-family: var\(--font-ui\);/s);
  });

  it('wires Tailwind font-sans to the same token', async () => {
    // The four `font-sans` sites exist to leave a mono ancestor and re-enter UI
    // prose; without this they re-entered Tailwind's default system stack.
    const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'tailwind.config.js')).href);
    const cfg = (mod.default ?? mod) as { theme: { extend: { fontFamily: { sans: string[] } } } };
    expect(cfg.theme.extend.fontFamily.sans).toEqual(['var(--font-ui)']);
  });

  it('keeps the Hangul mono face out of the UI stack', () => {
    // JetBrainsMonoHangul is a TERMINAL face (a font-family option in Settings);
    // it must never be spliced into the UI/prose stack.
    const uiDecl = /--font-ui:\s*([^;]+);/.exec(css)?.[1] ?? '';
    expect(uiDecl).not.toContain('JetBrainsMonoHangul');
  });
});
