import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// #3000 — one terminal has two onChangeColors listeners that acquire the
// shared glyph atlas: WebglRenderer (with the GPU's MAX_TEXTURE_SIZE) and the
// link render layer (upstream hardcodes 2048). Their configs never compare
// equal, so every theme assignment moved the terminal to a fresh TextureAtlas
// and dropped the previous one — two canvases per terminal per assignment,
// which the renderer never freed. The patch gives the layer the renderer's
// limit and releases atlas canvases on dispose/evict. These assertions pin
// both halves in the installed bundles and the shipped sources.

const ADDON = 'node_modules/@xterm/addon-webgl';
const BUNDLES = [`${ADDON}/lib/addon-webgl.js`, `${ADDON}/lib/addon-webgl.mjs`];

describe('addon-webgl shared atlas config (#3000)', () => {
  it.each(BUNDLES)('%s: the link layer no longer acquires the atlas with a hardcoded 2048', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/\.dpr,2048\)/);
    expect(src).toContain('this._deviceMaxTextureSize??2048');
  });

  it.each(BUNDLES)('%s: the renderer hands its MAX_TEXTURE_SIZE to its render layers', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('this._renderLayers.forEach(l=>l._deviceMaxTextureSize=this._deviceMaxTextureSize)');
  });

  it.each(BUNDLES)('%s: dropped atlas canvases release their backing store', (file) => {
    const src = readFileSync(file, 'utf8');
    // dispose(): tmp canvas + every page; _evictAllPages(): every page.
    expect(src).toContain('this._tmpCanvas.width=this._tmpCanvas.height=0');
    expect(src.match(/\.canvas\.remove\(\),(\w)\.canvas\.width=\1\.canvas\.height=0/g)?.length).toBe(2);
  });

  it('the shipped TypeScript sources carry the same change', () => {
    expect(readFileSync(`${ADDON}/src/renderLayer/BaseRenderLayer.ts`, 'utf8')).toContain('this._deviceMaxTextureSize ?? 2048');
    expect(readFileSync(`${ADDON}/src/WebglRenderer.ts`, 'utf8')).toContain('layer._deviceMaxTextureSize = this._deviceMaxTextureSize');
    expect(readFileSync(`${ADDON}/src/TextureAtlas.ts`, 'utf8')).toContain('page.canvas.width = page.canvas.height = 0');
  });
});
