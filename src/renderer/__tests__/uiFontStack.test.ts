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

/** Every @font-face block that declares the given font-family. */
function faces(family: string): string[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((body) => body.includes(`font-family: '${family}';`));
}
const interFaces = (): string[] => faces('Inter');

/** Every --font-ui stack in globals.css, split into families: `:root` first. */
function uiStacks(): string[][] {
  return [...css.matchAll(/--font-ui:\s*([^;]+);/g)].map((m) => m[1].split(',').map((f) => f.trim()));
}

const HANGUL = "'wmux Hangul'";
/** Hangul Jamo, Compatibility Jamo, Jamo Extended-A, Syllables, Jamo Extended-B. */
const HANGUL_BLOCKS: Array<[number, number]> = [
  [0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xd7b0, 0xd7ff],
];

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

  it('leads the --font-ui stack with the platform UI face', () => {
    const families = uiStacks()[0];
    expect(families).toBeDefined();
    // The mono look (2026-10-03) uses the system face: SF on macOS, Segoe UI
    // on Windows. Neither has Hangul, so Hangul falls through to the bundled
    // face right after it instead of to Malgun Gothic / Apple SD Gothic Neo.
    expect(families[0]).toBe('system-ui');
    expect(families[1]).toBe(HANGUL);
    expect(families).toContain("'Segoe UI'");
    expect(families.join(',')).not.toMatch(/Gothic|Malgun|Apple SD/i);
  });

  it("puts the Hangul face right after each look's Latin face", () => {
    // Owner decision 2026-11-04: keep the look's Latin face and render Hangul
    // only in the bundled face, so Korean keeps the look's size and weight.
    const looks = uiStacks().slice(1);
    expect(looks).toHaveLength(5);
    for (const families of looks) {
      expect(families[0]).toMatch(/^'(Geist|IBM Plex Sans|Figtree)'$/);
      expect(families[1]).toBe(HANGUL);
    }
  });

  it('bundles the Hangul face for Hangul codepoints only', () => {
    const hangul = faces('wmux Hangul');
    expect(hangul).toHaveLength(1);
    const [body] = hangul;
    // Instanced to the weights the UI uses, so 700 is real, not clamped to 600.
    expect(body).toMatch(/font-weight:\s*400 700;/);
    expect(body).toMatch(/font-display:\s*swap;/);
    const file = /url\('\.\.\/assets\/fonts\/([^']+)'\)/.exec(body)?.[1];
    expect(file).toBe('wmuxHangul.woff2');
    expect(fs.existsSync(path.join(__dirname, '..', 'assets', 'fonts', file as string))).toBe(true);
    // Every range must sit inside a Hangul block, so it can never take a Latin
    // glyph from the face ahead of it.
    const ranges = /unicode-range:\s*([^;]+);/.exec(body)?.[1].split(',').map((r) => r.trim()) ?? [];
    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      const m = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(range);
      expect(m, range).not.toBeNull();
      const lo = parseInt((m as RegExpExecArray)[1], 16);
      const hi = parseInt((m as RegExpExecArray)[2] ?? (m as RegExpExecArray)[1], 16);
      expect(HANGUL_BLOCKS.some(([a, b]) => lo >= a && hi <= b), range).toBe(true);
    }
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
    for (const families of uiStacks()) {
      expect(families.join(',')).not.toContain('JetBrainsMonoHangul');
    }
  });
});
