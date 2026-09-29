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
  load: (term: object, env: Record<string, unknown>) => boolean;
  sync: (term: object, env: Record<string, unknown>) => boolean;
}
interface Replies {
  isDeviceReply: (d: string) => boolean;
  guard: (send: (d: string) => void) => (d: string) => void;
}
let gate: Gate;
let replies: Replies;

function evaluate<T>(file: string, name: string): T {
  const sandbox: Record<string, unknown> = { WeakMap };
  runInNewContext(readText(frontend(file)), sandbox);
  return sandbox[name] as T;
}

beforeAll(() => {
  gate = evaluate<Gate>('inlineImages.js', 'wmuxInlineImages');
  replies = evaluate<Replies>('deviceReply.js', 'wmuxDeviceReply');
});

class FakeAddon {
  disposed = false;
  constructor(public opts: Record<string, unknown>) {}
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
  it('inlines the addon after xterm and both helpers before app.js', () => {
    expect(html.indexOf('/*__ADDON_IMAGE_JS__*/')).toBeGreaterThan(html.indexOf('/*__XTERM_JS__*/'));
    expect(html.indexOf('/*__INLINE_IMAGES_JS__*/')).toBeLessThan(html.indexOf('/*__APP_JS__*/'));
    expect(html.indexOf('/*__DEVICE_REPLY_JS__*/')).toBeLessThan(html.indexOf('/*__APP_JS__*/'));
    expect(build).toContain("inject(html, '/*__ADDON_IMAGE_JS__*/', addonImageJs)");
    expect(build).toContain("inject(html, '/*__INLINE_IMAGES_JS__*/', inlineImagesJs)");
    expect(build).toContain("inject(html, '/*__DEVICE_REPLY_JS__*/', deviceReplyJs)");
  });

  it('wires the gate, the reply guard and the config refresh into app.js', () => {
    expect(app).toMatch(/term\.open\(termHost\);\s+loadImageAddon\(term\);/);
    expect(app).toMatch(/tile\.term\.open\(host\);\s+loadImageAddon\(tile\.term\);/);
    expect(app).toContain('term.onData(wmuxDeviceReply.guard(');
    expect(app).toContain('tile.term.onData(wmuxDeviceReply.guard(');
    expect(app).toContain('inlineImagesEnabled = cfg.inlineImages !== false;');
    expect(app.match(/refreshInlineImages\(\); \}/g)?.length).toBe(2);
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

describe('web client device replies', () => {
  it('a DA1 / DA2 / status query in the output sends nothing to the pane', async () => {
    const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    const sent: string[] = [];
    const raw: string[] = [];
    t.onData((d) => raw.push(d));
    t.onData(replies.guard((d) => sent.push(d)));
    const queries = '\x1b[c\x1b[>c\x1b[6n\x1b[5n\x1b[?1;1;0S\x1b]11;?\x07';
    await new Promise<void>((resolve) => t.write(`out${queries}put\r\n`, resolve));
    expect(raw.length).toBeGreaterThan(0); // xterm did answer
    expect(sent).toEqual([]);
    t.dispose();
  });

  it('recognises the addon and window replies and lets typing through', () => {
    for (const reply of ['\x1b[?62;4;9;22c', '\x1b[?1;0;256S', '\x1b[?2;0;2048;2048S', '\x1b[4;480;640t', '\x1b[>0;276;0c']) {
      expect(replies.isDeviceReply(reply)).toBe(true);
    }
    for (const key of ['a', '\r', '\x1b[A', '\x1b[1;5A', '\x1b[15~', '\x1bOS', '\x03', '\x1b[97;5u', 'cat six.txt']) {
      expect(replies.isDeviceReply(key)).toBe(false);
    }
    const sent: string[] = [];
    const send = replies.guard((d) => sent.push(d));
    send('\x1b[?62;4;9;22c');
    send('ls\r');
    expect(sent).toEqual(['ls\r']);
  });
});
