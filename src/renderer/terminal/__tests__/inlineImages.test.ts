// @vitest-environment jsdom
/**
 * #1641 inline images: the addon is attached once per Terminal instance,
 * detached cleanly by the Settings toggle, and answers DA1 exactly once —
 * advertising sixel (`4`) only while it is loaded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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
});
