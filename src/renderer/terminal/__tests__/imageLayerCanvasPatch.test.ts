// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

/**
 * Guards the @xterm/addon-image patch (patches/@xterm+addon-image+0.9.0.patch), #1925.
 *
 * addon-image 0.9.0 creates its image layer (the `.xterm-image-layer` 2D
 * canvas it appends next to the WebGL canvas the first time an image is
 * stored) with `getContext('2d', { alpha: true, desynchronized: true })`.
 * Chromium can hand a desynchronized canvas its own low-latency compositor
 * path; on the reporter's Windows 10 machine the pane went black at the
 * first sixel — the image stayed visible, the WebGL text under the
 * transparent image layer did not, and the daemon's screen still held the
 * text. Upstream dropped `desynchronized` from this canvas in xterm.js #5766
 * (addon-image 0.10); the patch backports that one flag.
 *
 * Same guard shape as searchAddonPatch / atlasStaleTexture: if the patch
 * silently stops applying (version drift, hybrid node_modules), this fails
 * instead of the bug coming back in the field.
 */
const ADDON = 'node_modules/@xterm/addon-image';
const BUNDLES = [`${ADDON}/lib/addon-image.js`, `${ADDON}/lib/addon-image.mjs`] as const;

type AddonModule = typeof import('@xterm/addon-image');

async function loadBundle(file: string): Promise<AddonModule> {
  const abs = path.resolve(file);
  if (file.endsWith('.mjs')) return (await import(/* @vite-ignore */ pathToFileURL(abs).href)) as AddonModule;
  return createRequire(abs)(abs) as AddonModule;
}

interface LayerRenderer {
  insertLayerToDom(): void;
  canvas?: HTMLCanvasElement;
}

describe('installed addon-image 0.9.0 image-layer canvas patch (#1925)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is the version the patch was cut against', () => {
    const pkg = JSON.parse(readFileSync(`${ADDON}/package.json`, 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.9.0');
  });

  it.each(BUNDLES)('%s creates the image layer without desynchronized', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('desynchronized:!0');
    expect(src).toContain('getContext("2d",{alpha:!0,desynchronized:!1/*wmux#1925');
  });

  it('src/ImageRenderer.ts matches the bundles', () => {
    const src = readFileSync(`${ADDON}/src/ImageRenderer.ts`, 'utf8');
    expect(src).not.toContain('desynchronized: true');
    expect(src).toContain("getContext('2d', { alpha: true, desynchronized: false })");
  });

  it.each(BUNDLES)('%s: the layer canvas the addon appends asks for a synchronized context', async (file) => {
    const mod = await loadBundle(file);
    const term = new Terminal({ allowProposedApi: true });
    const addon = new mod.ImageAddon();
    try {
      term.loadAddon(addon);
      const renderer = (addon as unknown as { _renderer: LayerRenderer })._renderer;
      expect(renderer).toBeTruthy();

      // The real insertLayerToDom, run against a document and screen element
      // (the unopened terminal has neither, which is what makes this reachable
      // without a 2D canvas implementation in jsdom).
      const screen = document.createElement('div');
      const calls: Array<{ canvas: HTMLCanvasElement; type: string; opts: unknown }> = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
        this: HTMLCanvasElement,
        type: string,
        opts?: unknown,
      ) {
        calls.push({ canvas: this, type, opts });
        return { clearRect: () => undefined } as never;
      } as never);
      const probe = Object.create(renderer, {
        document: { value: document },
        dimensions: { value: undefined },
        _terminal: { value: { _core: { screenElement: screen } } },
      }) as LayerRenderer;
      probe.insertLayerToDom();

      const layer = screen.querySelector('canvas.xterm-image-layer');
      expect(layer).not.toBeNull();
      const layerCalls = calls.filter((c) => c.canvas === layer);
      expect(layerCalls).toHaveLength(1);
      expect(layerCalls[0].type).toBe('2d');
      expect(layerCalls[0].opts).toEqual({ alpha: true, desynchronized: false });
    } finally {
      addon.dispose();
      term.dispose();
    }
  });
});
