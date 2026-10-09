import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, it, expect } from 'vitest';

/**
 * I6 — a texture slot must be re-uploaded whenever a different canvas sits at
 * its page index.
 *
 * GlyphRenderer re-uploads atlas page i only when
 * `pages[i].version !== slot.version`. In addon-webgl 0.19 every AtlasPage
 * started at version 0 and a cap merge always put its merged page at index
 * pages.length - 4 with version 1, so after two cap merges in a row a renderer
 * that drew a frame in between saw the same version on a different canvas,
 * skipped the upload, and sampled the new texcoords from the old texture:
 * persistent wrong glyphs (Hangul-heavy output hit it first). wmux patched
 * 0.19 to compare canvas identity as well.
 *
 * 0.20 fixes the root instead: every AtlasPage version comes from one global
 * monotonic counter, so a new canvas can never carry a version a slot already
 * recorded. The wmux patch dropped that hunk; this test pins the upstream
 * mechanism so a regression fails here, not in a Korean user's pane.
 *
 * The behavioural test drives the INSTALLED TextureAtlas source (bundled here
 * with esbuild, as the addon is) into two consecutive cap merges, and runs the
 * upload logic extracted from each SHIPPED bundle against it — the bundles are
 * what the app imports.
 */
const ADDON = 'node_modules/@xterm/addon-webgl';
const XTERM_SRC = path.resolve('node_modules/@xterm/xterm/src');
const BUNDLES = [`${ADDON}/lib/addon-webgl.js`, `${ADDON}/lib/addon-webgl.mjs`];
const MAX_PAGES = 16;

describe('addon-webgl atlas texture upload (I6) — source pins', () => {
  it('TextureAtlas.ts draws every page version from one global counter', () => {
    const src = readFileSync(`${ADDON}/src/TextureAtlas.ts`, 'utf8');
    expect(src).toContain('public static nextVersion: number = 0;');
    expect(src).toContain('public version = ++AtlasPage.nextVersion;');
    expect(src).toContain('mergedPage.version = ++AtlasPage.nextVersion;');
  });

  it.each(BUNDLES)('%s re-uploads on a version change in the upload loop', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(
      /this\._atlas\.pages\[(\w)\]\.version!==this\._atlasTextures\[\1\]\.version&&this\._bindAtlasPageTexture\(/,
    );
  });
});

// ---------- the installed TextureAtlas, with a minimal fake 2D canvas ----------

const isWide = (c: number): boolean => c >= 0xac00 && c <= 0xd7a3;

class FakeCtx {
  [key: string]: unknown;
  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    // A glyph-sized block of ink so every rasterized glyph occupies space.
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 4; y < Math.min(h, 30); y++) {
      for (let x = 4; x < Math.min(w, 32); x++) data[(y * w + x) * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
  }
  measureText(): { width: number } {
    return { width: 10 };
  }
}
class FakeCanvas {
  width = 0;
  height = 0;
  style = {};
  private readonly _ctx = new Proxy(new FakeCtx(), {
    get: (t, p) => (p in t ? t[p as string] : () => { /* every other 2D call is a no-op */ }),
    set: (t, p, v) => ((t[p as string] = v), true),
  });
  getContext(): unknown {
    return this._ctx;
  }
  remove(): void { /* never attached to a document */ }
}

const col = (r: number, g: number, b: number) => ({
  css: `rgb(${r},${g},${b})`,
  rgba: ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0,
});
const noCache = {
  setColor() { /* no cache: nothing to store */ },
  getColor() { return undefined; },
  setCss() { /* no cache: nothing to store */ },
  getCss() { return undefined; },
  clear() { /* no cache: nothing to clear */ },
};
const CONFIG = {
  customGlyphs: true, devicePixelRatio: 2, deviceMaxTextureSize: 4096, letterSpacing: 0, lineHeight: 1,
  fontSize: 13, fontFamily: 'monospace', fontWeight: 'normal', fontWeightBold: 'bold',
  deviceCellWidth: 16, deviceCellHeight: 34, deviceCharWidth: 16, deviceCharHeight: 30,
  allowTransparency: false, drawBoldTextInBrightColors: true, minimumContrastRatio: 1,
  colors: {
    foreground: col(220, 220, 220), background: col(10, 10, 10), cursor: col(255, 255, 255), cursorAccent: col(0, 0, 0),
    selectionForeground: undefined, selectionBackgroundTransparent: col(1, 1, 1), selectionBackgroundOpaque: col(1, 1, 1),
    selectionInactiveBackgroundTransparent: col(1, 1, 1), selectionInactiveBackgroundOpaque: col(1, 1, 1),
    ansi: Array.from({ length: 256 }, (_, i) => col(i, i, i)), contrastCache: noCache, halfContrastCache: noCache,
  },
};
const UNICODE = { wcwidth: (c: number) => (isWide(c) ? 2 : 1), getStringCellWidth: (s: string) => s.length };
const CM_RGB = 50331648;

interface AtlasLike {
  pages: { canvas: unknown; version: number }[];
  onRemoveTextureAtlasCanvas: (cb: () => void) => unknown;
  getRasterizedGlyph: (code: number, bg: number, fg: number, ext: number, restrict: boolean, domContainer: unknown) => unknown;
}
type AtlasCtor = { new (doc: unknown, config: unknown, unicode: unknown): AtlasLike; maxAtlasPages?: number; maxTextureSize?: number };

async function loadInstalledTextureAtlas(): Promise<AtlasCtor> {
  const out = await build({
    entryPoints: [path.resolve(`${ADDON}/src/TextureAtlas.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    alias: {
      browser: `${XTERM_SRC}/browser`,
      common: `${XTERM_SRC}/common`,
      vs: `${XTERM_SRC}/vs`,
    },
  });
  const mod: { exports: { TextureAtlas?: AtlasCtor } } = { exports: {} };
  // The bundle is self-contained (every import is inlined), so it gets no require.
  const noRequire = (id: string): never => {
    throw new Error(`unexpected require(${id}) from the TextureAtlas bundle`);
  };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, noRequire);
  if (!mod.exports.TextureAtlas) throw new Error('TextureAtlas export not found');
  return mod.exports.TextureAtlas;
}

// ---------- the shipped upload logic, lifted out of a bundle ----------

/** Text of the `{...}` block that starts at `open` (balanced braces; the
 *  extracted methods contain no string or regex literals with braces). */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced block');
}
function method(src: string, name: string): string {
  const m = new RegExp(`[;}]${name}\\(((?:\\w+(?:,\\w+)*)?)\\)\\{`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return `${name}(${m[1]})${block(src, m.index + m[0].length - 1)}`;
}

interface Slot { texture: unknown; version: number }
interface ShippedRenderer {
  _atlas: AtlasLike | undefined;
  _atlasTextures: Slot[];
  setAtlas(atlas: AtlasLike): void;
  uploadStalePages(gl: unknown): void;
}

function shippedRenderer(file: string): ShippedRenderer {
  const src = readFileSync(file, 'utf8');
  // GlyphRenderer.render(): the loop that re-uploads stale pages. 0.20 computes
  // its bound (pages clamped to the texture slots) in an earlier statement, so
  // the lifted loop gets the same bound re-declared in front of it.
  const loop = /for\(let (\w)=0;\1<(\w);\1\+\+\)this\._atlas\.pages\[\1\]\.version!==this\._atlasTextures\[\1\]\.version&&this\._bindAtlasPageTexture\((\w),this\._atlas,\1\);/.exec(src);
  if (!loop) throw new Error(`upload loop not found in ${file}`);
  const bound = `const ${loop[2]}=Math.min(this._atlas.pages.length,this._atlasTextures.length);`;
  const glVar = loop[3];
  // WebglUtils.GLTexture.
  const tex = /class\{constructor\((\w)\)\{this\.texture=\1,this\.version=-1[^}]*\}\}/.exec(src);
  if (!tex) throw new Error(`GLTexture not found in ${file}`);
  const body = `return {
    ${method(src, 'setAtlas')},
    ${method(src, 'invalidateAtlasTextures')},
    ${method(src, '_bindAtlasPageTexture')},
    uploadStalePages(${glVar}){${bound}${loop[0]}},
    GLTexture: ${tex[0]},
  };`;
  const r = new Function(body)() as ShippedRenderer & { GLTexture: new (t: unknown) => Slot };
  r._atlasTextures = Array.from({ length: MAX_PAGES }, (_, i) => new r.GLTexture({ unit: i }));
  return r;
}

/** Fake WebGL context: records which canvas each texture unit was given. */
function fakeGl(uploads: Map<number, unknown>): unknown {
  let active = 0;
  const gl: Record<string, unknown> = {
    TEXTURE0: 0,
    activeTexture: (unit: number) => { active = unit; },
    texImage2D: (...args: unknown[]) => { uploads.set(active, args[args.length - 1]); },
  };
  return new Proxy(gl, { get: (t, p) => (p in t ? t[p as string] : typeof p === 'string' && /^[A-Z_0-9]+$/.test(p) ? 0 : () => { /* every other GL call is a no-op */ }) });
}

describe('addon-webgl atlas texture upload (I6) — two cap merges in a row', () => {
  let TextureAtlas: AtlasCtor;
  beforeAll(async () => {
    TextureAtlas = await loadInstalledTextureAtlas();
    TextureAtlas.maxAtlasPages = MAX_PAGES;
    TextureAtlas.maxTextureSize = 4096;
  }, 30_000);

  it.each(BUNDLES)('%s re-uploads the merged slot after the second merge', (file) => {
    const atlas = new TextureAtlas({ createElement: () => new FakeCanvas() }, CONFIG, UNICODE);
    let removals = 0;
    atlas.onRemoveTextureAtlasCanvas(() => { removals++; });

    const uploads = new Map<number, unknown>();
    const gl = fakeGl(uploads);
    const renderer = shippedRenderer(file);
    renderer.setAtlas(atlas);

    // One "frame" = rasterize a screenful of distinct Hangul glyphs, then run
    // the shipped upload loop exactly as GlyphRenderer.render() does.
    let n = 0;
    const frame = (): void => {
      for (let i = 0; i < 1500; i++, n++) {
        atlas.getRasterizedGlyph(0xac00 + (n % 11172), 0, CM_RGB | ((n * 7919) & 0xffffff), 0, false, undefined);
      }
      renderer.uploadStalePages(gl);
    };

    const mergedIndex = MAX_PAGES - 4;
    let firstMerge: { canvas: unknown; version: number } | undefined;
    for (let f = 0; f < 200 && removals < 8; f++) {
      frame();
      if (!firstMerge && removals >= 4) firstMerge = { ...atlas.pages[mergedIndex] };
    }
    // Two cap merges (4 canvases removed each), with frames drawn in between.
    expect(removals).toBeGreaterThanOrEqual(8);
    expect(firstMerge).toBeDefined();

    const page = atlas.pages[mergedIndex];
    // The case 0.19 got wrong: a different canvas at the same index. It must
    // now carry a different version, so the version-only check re-uploads.
    expect(page.canvas).not.toBe(firstMerge!.canvas);
    expect(page.version).not.toBe(firstMerge!.version);

    // Every texture unit was last given the canvas that is now on its page.
    for (let i = 0; i < atlas.pages.length; i++) {
      expect(uploads.get(i), `texture unit ${i}`).toBe(atlas.pages[i].canvas);
    }
  });

  it.each(BUNDLES)('%s setAtlas forgets the uploaded versions', (file) => {
    const renderer = shippedRenderer(file);
    renderer._atlasTextures[0].version = 3;
    renderer.setAtlas({ pages: [] } as unknown as AtlasLike);
    expect(renderer._atlasTextures[0].version).toBe(-1);
  });
});
