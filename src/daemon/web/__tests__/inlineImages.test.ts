import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Terminal } from '@xterm/headless';

// Inline images in the web client (#1641). There is no bundler: the gate runs
// only if a marker inlines it, so the shipped file is evaluated verbatim.
const root = join(__dirname, '..', '..', '..', '..');
const frontend = (name: string) => join(root, 'src', 'daemon', 'web', 'frontend', name);
const html = readFileSync(frontend('index.html'), 'utf8');
const app = readFileSync(frontend('app.js'), 'utf8');
const build = readFileSync(join(root, 'scripts', 'build-daemon-web.mjs'), 'utf8');

interface Gate {
  OPTIONS: Record<string, unknown>;
  wasmUsable: (wa: unknown) => boolean;
  load: (term: { loadAddon: (a: unknown) => void }, env: Record<string, unknown>) => boolean;
}
let gate: Gate;

beforeAll(() => {
  const sandbox: Record<string, unknown> = {};
  runInNewContext(readFileSync(frontend('inlineImages.js'), 'utf8'), sandbox);
  gate = sandbox.wmuxInlineImages as Gate;
});

class FakeAddon {
  constructor(public opts: unknown) {}
}
const addonModule = { ImageAddon: FakeAddon };
// What a page refused by CSP (or a pre-CSP3 browser) sees.
const blockedWasm = {
  Module: function () { throw new Error('CompileError: refused by Content Security Policy'); },
  Instance: function () { return {}; },
};

describe('web client inline images', () => {
  it('inlines the addon after xterm and the gate before app.js', () => {
    expect(html.indexOf('/*__ADDON_IMAGE_JS__*/')).toBeGreaterThan(html.indexOf('/*__XTERM_JS__*/'));
    expect(html.indexOf('/*__INLINE_IMAGES_JS__*/')).toBeLessThan(html.indexOf('/*__APP_JS__*/'));
    expect(build).toContain("inject(html, '/*__ADDON_IMAGE_JS__*/', addonImageJs)");
    expect(build).toContain("inject(html, '/*__INLINE_IMAGES_JS__*/', inlineImagesJs)");
  });

  it('loads through the gate into the 1-up terminal and every tile', () => {
    expect(app).toContain('term.open(termHost);\n      loadImageAddon(term);');
    expect(app).toContain('tile.term.open(host);\n    loadImageAddon(tile.term);');
    expect(app).toContain('inlineImagesEnabled = cfg.inlineImages !== false;');
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
    const term = { loadAddon: vi.fn() };
    expect(gate.wasmUsable(WebAssembly)).toBe(true);
    expect(gate.load(term, { enabled: true, ImageAddon: addonModule, WebAssembly })).toBe(true);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('does not load the addon at all when the wasm probe fails', () => {
    const term = { loadAddon: vi.fn() };
    expect(gate.wasmUsable(blockedWasm)).toBe(false);
    expect(gate.wasmUsable(null)).toBe(false);
    expect(gate.load(term, { enabled: true, ImageAddon: addonModule, WebAssembly: blockedWasm })).toBe(false);
    expect(gate.load(term, { enabled: true, ImageAddon: addonModule, WebAssembly: null })).toBe(false);
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it('does not load the addon when the server switched images off', () => {
    const term = { loadAddon: vi.fn() };
    expect(gate.load(term, { enabled: false, ImageAddon: addonModule, WebAssembly })).toBe(false);
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it('a throwing addon leaves the terminal alone', () => {
    const term = { loadAddon: vi.fn(() => { throw new Error('activate failed'); }) };
    expect(gate.load(term, { enabled: true, ImageAddon: addonModule, WebAssembly })).toBe(false);
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
