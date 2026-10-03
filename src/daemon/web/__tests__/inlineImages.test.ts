import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Terminal } from '@xterm/headless';

// Inline images in the web client (#1641). There is no bundler: the gate runs
// only if a marker inlines it, so the shipped files are evaluated verbatim.
const root = join(__dirname, '..', '..', '..', '..');
const frontend = (name: string) => join(root, 'src', 'daemon', 'web', 'frontend', name);
// Normalised: a Windows checkout with autocrlf hands these over with CRLF.
const readText = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const html = readText(frontend('index.html'));
const app = readText(frontend('app.js'));
const build = readText(join(root, 'scripts', 'build-daemon-web.mjs'));

interface Gate {
  OPTIONS: Record<string, unknown>;
  wasmUsable: (wa: unknown) => boolean;
  optionsFor: (env: Record<string, unknown>) => Record<string, unknown>;
  capSixel: (addon: object, pixelLimit: number) => boolean;
  load: (term: object, env: Record<string, unknown>) => boolean;
  sync: (term: object, env: Record<string, unknown>) => boolean;
}
let gate: Gate;

function evaluate<T>(file: string, name: string): T {
  const sandbox: Record<string, unknown> = { WeakMap };
  runInNewContext(readText(frontend(file)), sandbox);
  return sandbox[name] as T;
}

beforeAll(() => {
  gate = evaluate<Gate>('inlineImages.js', 'wmuxInlineImages');
});

// The addon's sixel handler as far as capSixel touches it (addon 0.9.x).
class FakeSixelHandler {
  _aborted = false;
  _dec = { width: 0, height: 0, release: vi.fn() };
  /** The addon's own unhook: decodes the pixels and draws the canvas. */
  draw = vi.fn((_success: boolean) => true);
  unhook = this.draw;
}
class FakeAddon {
  disposed = false;
  _handlers = new Map<string, FakeSixelHandler>();
  constructor(public opts: Record<string, unknown>) {
    if (opts.sixelSupport !== false) this._handlers.set('sixel', new FakeSixelHandler());
  }
  dispose() { this.disposed = true; }
}
const addonModule = { ImageAddon: FakeAddon };
const bitmap = () => undefined;
// What a page refused by CSP (or a pre-CSP3 browser) sees.
const blockedWasm = {
  Module: function () { throw new Error('CompileError: refused by Content Security Policy'); },
  Instance: function () { return {}; },
};
const env = (over: Record<string, unknown> = {}) => ({
  enabled: true, ImageAddon: addonModule, WebAssembly, createImageBitmap: bitmap, ...over,
});
const fakeTerm = () => ({ loadAddon: vi.fn() });

describe('web client inline images', () => {
  it('inlines the addon after xterm and the gate before app.js', () => {
    expect(html.indexOf('/*__ADDON_IMAGE_JS__*/')).toBeGreaterThan(html.indexOf('/*__XTERM_JS__*/'));
    expect(html.indexOf('/*__INLINE_IMAGES_JS__*/')).toBeLessThan(html.indexOf('/*__APP_JS__*/'));
    expect(build).toContain("inject(html, '/*__ADDON_IMAGE_JS__*/', addonImageJs)");
    expect(build).toContain("inject(html, '/*__INLINE_IMAGES_JS__*/', inlineImagesJs)");
  });

  it('wires the gate, the user-input gate and the config refresh into app.js', () => {
    expect(app).toMatch(/term\.open\(termHost\);\s+loadImageAddon\(term\);/);
    expect(app).toMatch(/tile\.term\.open\(host\);\s+loadImageAddon\(tile\.term\);/);
    expect(app).toContain('term.onData(gateUserInput(term, ');
    expect(app).toContain('tile.term.onData(gateUserInput(tile.term, ');
    expect(app).toContain('shared.gateUserInput(t, send)');
    expect(app).toContain('inlineImagesEnabled = cfg.inlineImages !== false;');
    // The switch rides the snapshot meta and is applied before the repaint;
    // /api/config is asked only when a meta predates it, never on open.
    expect(app).toContain('if (!m.resize && inlineImagesFromMeta(m)) applyInlineImages(inlineImagesEnabled);');
    expect(app).toContain('var carried = !m.resize && inlineImagesFromMeta(m);');
    expect(app).toContain('if (carried) applyInlineImages(inlineImagesEnabled);');
    expect(app.match(/if \(!snapMeta \|\| typeof snapMeta\.inlineImages !== 'boolean'\) refreshInlineImages\(\);/g)?.length).toBe(2);
    expect(app).not.toMatch(/open: function \(\) \{[^}]*refreshInlineImages/);
  });

  it('keeps mobile limits and never answers size queries', () => {
    expect(gate.OPTIONS).toMatchObject({
      enableSizeReports: false,
      pixelLimit: 2048 * 2048,
      sixelSizeLimit: 4000000,
      iipSizeLimit: 4000000,
      storageLimit: 24,
    });
  });

  it('loads the addon where wasm compiles and instantiates', () => {
    const term = fakeTerm();
    expect(gate.wasmUsable(WebAssembly)).toBe(true);
    expect(gate.load(term, env())).toBe(true);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('does not load the addon at all when the wasm probe fails', () => {
    const term = fakeTerm();
    expect(gate.wasmUsable(blockedWasm)).toBe(false);
    expect(gate.wasmUsable(null)).toBe(false);
    expect(gate.load(term, env({ WebAssembly: blockedWasm }))).toBe(false);
    expect(gate.load(term, env({ WebAssembly: null }))).toBe(false);
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it('does not load the addon when the server switched images off', () => {
    const term = fakeTerm();
    expect(gate.load(term, env({ enabled: false }))).toBe(false);
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it('a switch that turns off on reconnect disposes the loaded addon, and back on reloads it', () => {
    const term = fakeTerm();
    expect(gate.sync(term, env())).toBe(true);
    expect(gate.sync(term, env())).toBe(true);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    const addon = term.loadAddon.mock.calls[0][0] as FakeAddon;
    expect(gate.sync(term, env({ enabled: false }))).toBe(false);
    expect(addon.disposed).toBe(true);
    expect(gate.sync(term, env())).toBe(true);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
  });

  it('a throwing addon is disposed and leaves the terminal alone', () => {
    const term = { loadAddon: vi.fn(() => { throw new Error('activate failed'); }) };
    expect(gate.load(term, env())).toBe(false);
    expect((term.loadAddon.mock.calls[0] as unknown[])[0]).toMatchObject({ disposed: true });
  });

  it('drops a finished sixel over pixelLimit before the addon draws it', () => {
    const term = fakeTerm();
    expect(gate.load(term, env())).toBe(true);
    const handler = (term.loadAddon.mock.calls[0][0] as FakeAddon)._handlers.get('sixel')!;
    const draw = handler.draw;
    handler._dec.width = 16380;
    handler._dec.height = 6006;
    expect(handler.unhook(true)).toBe(true);
    expect(draw).not.toHaveBeenCalled();
    expect(handler._dec.release).toHaveBeenCalled();
    expect(handler._aborted).toBe(true);
  });

  it('draws a sixel within pixelLimit as before', () => {
    const term = fakeTerm();
    gate.load(term, env());
    const handler = (term.loadAddon.mock.calls[0][0] as FakeAddon)._handlers.get('sixel')!;
    const draw = handler.draw;
    handler._dec.width = 2048;
    handler._dec.height = 2048;
    handler.unhook(true);
    expect(draw).toHaveBeenCalledWith(true);
  });

  it('runs without sixel when the size cap cannot be installed', () => {
    class Opaque extends FakeAddon {
      constructor(opts: Record<string, unknown>) { super(opts); this._handlers.clear(); }
    }
    const term = fakeTerm();
    expect(gate.load(term, env({ ImageAddon: { ImageAddon: Opaque } }))).toBe(true);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
    const [first, second] = term.loadAddon.mock.calls.map((c) => c[0] as FakeAddon);
    expect(first.disposed).toBe(true);
    expect(second.opts.sixelSupport).toBe(false);
  });

  it('keeps iTerm2 images off where createImageBitmap is missing', () => {
    expect(gate.optionsFor(env()).iipSupport).toBe(true);
    expect(gate.optionsFor(env({ createImageBitmap: null })).iipSupport).toBe(false);
    expect(gate.optionsFor(env({ createImageBitmap: null })).sixelSupport).toBe(true);
  });

  it('without the addon, output after an OSC 1337 image and a sixel still lands', async () => {
    // The terminal a failed probe leaves behind: plain xterm, which skips both
    // sequences and keeps parsing.
    const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const png = Buffer.from('not really a png').toString('base64');
    const bytes =
      `\x1b]1337;File=inline=1;size=16:${png}\x07\r\n` +
      '\x1bPq#0;2;100;0;0#0~~~~\x1b\\\r\n' +
      'alive\r\n';
    await new Promise<void>((resolve) => t.write(bytes, resolve));
    const lines = Array.from({ length: t.buffer.active.length }, (_, i) =>
      t.buffer.active.getLine(i)?.translateToString(true) ?? '');
    expect(lines).toContain('alive');
    t.dispose();
  });
});
