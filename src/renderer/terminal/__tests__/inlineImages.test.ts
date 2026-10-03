// @vitest-environment jsdom
/**
 * #1641 inline images: the addon is attached once per Terminal instance,
 * detached cleanly by the Settings toggle, and answers DA1 exactly once —
 * advertising sixel (`4`) only while it is loaded.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  INLINE_IMAGE_ADDON_OPTIONS,
  attachInlineImages,
  detachInlineImages,
  getInlineImageAddon,
  preloadInlineImageAddon,
  syncInlineImages,
} from '../inlineImages';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

async function replies(term: Terminal, query: string): Promise<string[]> {
  const out: string[] = [];
  const sub = term.onData((d) => out.push(d));
  await write(term, query);
  sub.dispose();
  return out;
}

describe('inline image addon (#1641)', () => {
  // Load the chunk first so attach is synchronous, as it is after boot.
  beforeAll(async () => {
    // jsdom has no 2D canvas; the addon only needs one to draw.
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    await preloadInlineImageAddon();
  });

  it('answers DA1 once, with sixel, while attached — and once without it after detach', async () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      expect(await replies(term, '\x1b[c')).toEqual(['\x1b[?1;2c']);

      attachInlineImages(term);
      expect(getInlineImageAddon(term)).not.toBeNull();
      expect(await replies(term, '\x1b[c')).toEqual(['\x1b[?62;4;9;22c']);

      detachInlineImages(term);
      expect(getInlineImageAddon(term)).toBeNull();
      expect(await replies(term, '\x1b[c')).toEqual(['\x1b[?1;2c']);
    } finally {
      term.dispose();
    }
  });

  it('attaches one addon per terminal however many times it is synced', async () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      syncInlineImages(term, true);
      const first = getInlineImageAddon(term);
      syncInlineImages(term, true);
      attachInlineImages(term);
      expect(getInlineImageAddon(term)).toBe(first);
      // A second addon would register a second DA1 handler; still one reply.
      expect(await replies(term, '\x1b[c')).toHaveLength(1);
    } finally {
      term.dispose();
    }
  });

  it('restores windowOptions on detach, so size reports stop with the addon', async () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      // A pre-existing choice survives; the addon's additions do not.
      term.options.windowOptions = { getWinSizeChars: true };
      syncInlineImages(term, true);
      expect(term.options.windowOptions?.getCellSizePixels).toBe(true);
      expect(term.options.windowOptions?.getWinSizePixels).toBe(true);
      syncInlineImages(term, false);
      expect(term.options.windowOptions).toEqual({ getWinSizeChars: true });
    } finally {
      term.dispose();
    }
  });

  it('keeps per-pane limits below the addon defaults', () => {
    expect(INLINE_IMAGE_ADDON_OPTIONS.pixelLimit).toBe(2 ** 23);
    expect(INLINE_IMAGE_ADDON_OPTIONS.storageLimit).toBe(64);
    expect(INLINE_IMAGE_ADDON_OPTIONS.sixelSizeLimit).toBe(16 * 1024 * 1024);
    expect(INLINE_IMAGE_ADDON_OPTIONS.iipSizeLimit).toBe(16 * 1024 * 1024);
    const term = new Terminal({ allowProposedApi: true });
    try {
      attachInlineImages(term);
      expect(getInlineImageAddon(term)!.storageLimit).toBe(64);
    } finally {
      term.dispose();
    }
  });

  it('caps a sixel image\'s finished size at pixelLimit, and still draws one within it', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    const spies: Array<{ mockRestore(): void }> = [];
    // A 2D context and ImageData for this test only, so the addon's draw path
    // (`getContext('2d')?.putImageData(new ImageData(dec.data8, …))`) really
    // runs: with the suite's null context the optional chain skips data8.
    const nullContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({ putImageData: () => undefined })) as never;
    const g = globalThis as { ImageData?: unknown };
    const hadImageData = 'ImageData' in g;
    const RealImageData = g.ImageData;
    const imageData: string[] = [];
    g.ImageData = class {
      constructor(_data: unknown, width: number, height: number) { imageData.push(`${width}x${height}`); }
    };
    try {
      attachInlineImages(term);
      const addon = getInlineImageAddon(term) as unknown as {
        _handlers: Map<string, { _dec?: object }>;
        _storage: { addImage(canvas: HTMLCanvasElement): void };
      };
      const sixel = addon._handlers.get('sixel')!;
      for (let i = 0; i < 100 && !sixel._dec; i++) await new Promise((r) => setTimeout(r, 10));
      expect(sixel._dec).toBeTruthy();
      // What the addon's unhook does to draw: read the pixels, store a canvas.
      const pixelReads = vi.spyOn(Object.getPrototypeOf(sixel._dec), 'data8', 'get');
      const stored = vi.spyOn(addon._storage, 'addImage').mockImplementation(() => undefined);
      spies.push(pixelReads, stored);

      // 16380 x 6006 px: over 2^23, though the sequence itself is ~2 KB.
      await write(term, `\x1bPq#0;2;100;0;0#0!16380~-${'~-'.repeat(1000)}\x1b\\after-large\r\n`);
      expect(pixelReads).not.toHaveBeenCalled();
      expect(stored).not.toHaveBeenCalled();
      const text = Array.from({ length: term.buffer.active.length }, (_, y) =>
        term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n');
      expect(text).toContain('after-large');

      expect(imageData).toEqual([]);

      await write(term, '\x1bPq#0;2;0;80;0#0!40~-!40~\x1b\\');
      expect(pixelReads).toHaveBeenCalled();
      expect(imageData).toEqual(['40x12']);
      expect(stored).toHaveBeenCalledTimes(1);
      const canvas = stored.mock.calls[0][0];
      expect([canvas.width, canvas.height]).toEqual([40, 12]);
    } finally {
      spies.forEach((s) => s.mockRestore());
      HTMLCanvasElement.prototype.getContext = nullContext;
      if (hadImageData) g.ImageData = RealImageData;
      else delete g.ImageData;
      term.dispose();
    }
  });

  it('loads the addon without sixel when the size cap cannot be installed', async () => {
    vi.resetModules();
    vi.doMock('../../../shared/terminal/sixelCap', () => ({ capSixelImageSize: () => false }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const term = new Terminal({ allowProposedApi: true });
    try {
      const fresh = await import('../inlineImages');
      await fresh.preloadInlineImageAddon();
      fresh.attachInlineImages(term);
      const addon = fresh.getInlineImageAddon(term) as unknown as { _opts: { sixelSupport: boolean } } | null;
      expect(addon).not.toBeNull();
      // The replacement addon, not the first one: sixel off, the rest kept.
      expect(addon!._opts.sixelSupport).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sixel size cap unavailable'));
      // DA1 no longer advertises sixel (`4`), and is answered once.
      const da1 = await replies(term, '\x1b[c');
      expect(da1).toHaveLength(1);
      expect(da1[0]).not.toMatch(/[?;]4[;c]/);
    } finally {
      warn.mockRestore();
      vi.doUnmock('../../../shared/terminal/sixelCap');
      vi.resetModules();
      term.dispose();
    }
  });

  it('never loads the addon where WebAssembly cannot compile (CSP), so images cannot stall output', async () => {
    vi.resetModules();
    const Real = WebAssembly.Module;
    const spy = vi.spyOn(WebAssembly, 'Module').mockImplementation(() => {
      throw new WebAssembly.CompileError('blocked by CSP');
    });
    const term = new Terminal({ allowProposedApi: true });
    try {
      const fresh = await import('../inlineImages');
      fresh.attachInlineImages(term);
      expect(fresh.getInlineImageAddon(term)).toBeNull();
      expect(await replies(term, '\x1b[c')).toEqual(['\x1b[?1;2c']);
      // An OSC 1337 image is ignored and the text after it still lands.
      await write(term, '\x1b]1337;File=inline=1:AAAA\x07after-iip\r\n\x1bPq#0!10~\x1b\\after-sixel');
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toContain('after-iip');
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toContain('after-sixel');
    } finally {
      spy.mockRestore();
      expect(WebAssembly.Module).toBe(Real);
      term.dispose();
    }
  });
});
