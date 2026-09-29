// @vitest-environment jsdom
/**
 * #1641 inline images: the addon is attached once per Terminal instance,
 * detached cleanly by the Settings toggle, answers DA1 exactly once
 * (advertising sixel only while loaded), never touches another terminal's
 * windowOptions, shares one storage budget, and is never loaded where its
 * WebAssembly decoders cannot run — so an image can never stall output.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

type Mod = typeof import('../inlineImages');

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

async function replies(term: Terminal, query: string): Promise<string[]> {
  const out: string[] = [];
  const sub = term.onData((d) => out.push(d));
  await write(term, query);
  sub.dispose();
  return out;
}

const terms: Terminal[] = [];
function term(): Terminal {
  const t = new Terminal({ allowProposedApi: true });
  terms.push(t);
  return t;
}

/** Fresh module state (probe result, live set) per test. */
async function load(): Promise<Mod> {
  vi.resetModules();
  const mod = await import('../inlineImages');
  return mod;
}

async function loadReady(): Promise<Mod> {
  const mod = await load();
  expect(await mod.preloadInlineImageAddon()).toBe(true);
  return mod;
}

beforeAll(() => {
  // jsdom has no 2D canvas; the addon only needs one to draw.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

afterEach(() => {
  vi.restoreAllMocks();
  while (terms.length) terms.pop()!.dispose();
});

describe('inline image addon (#1641)', () => {
  it('attaches synchronously once preloaded, and answers DA1 once — with sixel only while attached', async () => {
    const m = await loadReady();
    const t = term();
    expect(await replies(t, '\x1b[c')).toEqual(['\x1b[?1;2c']);
    m.attachInlineImages(t);
    expect(m.getInlineImageAddon(t)).not.toBeNull(); // no await: the first pane sees it
    expect(await replies(t, '\x1b[c')).toEqual(['\x1b[?62;4;9;22c']);
    m.detachInlineImages(t);
    expect(m.getInlineImageAddon(t)).toBeNull();
    expect(await replies(t, '\x1b[c')).toEqual(['\x1b[?1;2c']);
  });

  it('attaches one addon per terminal however many times it is synced', async () => {
    const m = await loadReady();
    const t = term();
    m.syncInlineImages(t, true);
    const first = m.getInlineImageAddon(t);
    m.syncInlineImages(t, true);
    m.attachInlineImages(t);
    expect(m.getInlineImageAddon(t)).toBe(first);
    expect(await replies(t, '\x1b[c')).toHaveLength(1);
  });

  it('keeps size reports per pane: a second pane turns them off, other terminals never get them', async () => {
    const m = await loadReady();
    const a = term();
    const b = term();
    m.attachInlineImages(a);
    m.attachInlineImages(b);
    expect(b.options.windowOptions?.getWinSizePixels).toBe(true);
    // A terminal created afterwards (e.g. the remote mirror) is untouched:
    // xterm 6 shares one default windowOptions object across terminals.
    expect(term().options.windowOptions?.getCellSizePixels).toBeFalsy();
    m.detachInlineImages(a);
    m.detachInlineImages(b);
    expect(b.options.windowOptions?.getWinSizePixels).toBeFalsy();
    expect(b.options.windowOptions?.getCellSizePixels).toBeFalsy();
    expect(a.options.windowOptions?.getWinSizePixels).toBeFalsy();
  });

  it('removes only the keys it added, keeping earlier and later choices', async () => {
    const m = await loadReady();
    const t = term();
    t.options.windowOptions = { getWinSizeChars: true };
    m.attachInlineImages(t);
    t.options.windowOptions = { ...t.options.windowOptions, getScreenSizeChars: true };
    m.detachInlineImages(t);
    expect(t.options.windowOptions).toEqual({ getWinSizeChars: true, getScreenSizeChars: true });
  });

  it('undoes a failed activation: no addon, no sixel in DA1, windowOptions restored', async () => {
    const m = await loadReady();
    const t = term();
    const real = t.loadAddon.bind(t);
    vi.spyOn(t, 'loadAddon').mockImplementationOnce((addon) => {
      real(addon); // handlers registered, then the load "fails"
      throw new Error('boom');
    });
    m.attachInlineImages(t);
    expect(m.getInlineImageAddon(t)).toBeNull();
    expect(t.options.windowOptions?.getCellSizePixels).toBeFalsy();
    expect(await replies(t, '\x1b[c')).toEqual(['\x1b[?1;2c']);
  });

  it('splits one storage budget across panes, within the per-pane cap and floor', async () => {
    const m = await loadReady();
    expect(m.INLINE_IMAGE_ADDON_OPTIONS.pixelLimit).toBe(2 ** 23);
    expect(m.INLINE_IMAGE_ADDON_OPTIONS.sixelSizeLimit).toBe(16 * 1024 * 1024);
    expect(m.INLINE_IMAGE_ADDON_OPTIONS.iipSizeLimit).toBe(16 * 1024 * 1024);
    const ts = Array.from({ length: 8 }, () => term());
    ts.forEach((t) => m.attachInlineImages(t));
    expect(m.getInlineImageAddon(ts[0])!.storageLimit).toBe(m.TOTAL_STORAGE_MB / 8);
    ts.slice(1).forEach((t) => m.detachInlineImages(t));
    expect(m.getInlineImageAddon(ts[0])!.storageLimit).toBe(64);
    const many = Array.from({ length: 40 }, () => term());
    many.forEach((t) => m.attachInlineImages(t));
    expect(m.getInlineImageAddon(ts[0])!.storageLimit).toBe(m.MIN_PANE_STORAGE_MB);
    // A terminal disposed while attached leaves the budget too.
    many.forEach((t) => t.dispose());
    expect(m.getInlineImageAddon(ts[0])!.storageLimit).toBe(64);
  });

  it('does not reuse image ids after an off/on toggle (old cells must not pick up new images)', async () => {
    const m = await loadReady();
    const t = term();
    m.attachInlineImages(t);
    const storage = (m.getInlineImageAddon(t) as unknown as { _storage: { _lastId: number; _lowestId: number } })._storage;
    expect(typeof storage._lastId).toBe('number'); // pinned internals still exist
    storage._lastId = 7;
    m.detachInlineImages(t);
    m.attachInlineImages(t);
    const next = (m.getInlineImageAddon(t) as unknown as { _storage: { _lastId: number; _lowestId: number } })._storage;
    expect(next._lastId).toBe(7);
    expect(next._lowestId).toBe(7);
  });

  it('turning the setting off detaches every live terminal, not only mounted ones', async () => {
    const m = await loadReady();
    const a = term();
    const b = term();
    m.attachInlineImages(a);
    m.attachInlineImages(b);
    m.applyInlineImagesSetting(false);
    expect(m.getInlineImageAddon(a)).toBeNull();
    expect(m.getInlineImageAddon(b)).toBeNull();
    expect(b.options.windowOptions?.getWinSizePixels).toBeFalsy();
  });

  it('never loads the addon where WebAssembly is blocked outright (CSP), and output keeps flowing', async () => {
    vi.spyOn(WebAssembly, 'Module').mockImplementation(() => {
      throw new WebAssembly.CompileError('blocked by CSP');
    });
    const m = await load();
    expect(await m.preloadInlineImageAddon()).toBe(false);
    const t = term();
    m.attachInlineImages(t);
    expect(m.getInlineImageAddon(t)).toBeNull();
    expect(await replies(t, '\x1b[c')).toEqual(['\x1b[?1;2c']);
    await write(t, '\x1b]1337;File=inline=1:AAAA\x07after-iip\r\n\x1bPq#0!10~\x1b\\after-sixel');
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toContain('after-iip');
    expect(t.buffer.active.getLine(1)?.translateToString(true)).toContain('after-sixel');
  });
});
