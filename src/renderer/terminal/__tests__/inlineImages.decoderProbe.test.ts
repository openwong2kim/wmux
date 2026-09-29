// @vitest-environment jsdom
/**
 * #1641: the capability check compiles only an 8-byte module, so it cannot
 * see a failure specific to the addon's real decoder modules. Those compile
 * lazily on first use and are cached in the addon's module scope — which is
 * why this lives in its own file: nothing may have imported the addon yet.
 */
import { it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

it('never loads the addon when only the real decoders fail to compile, and output keeps flowing', async () => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  const Real = WebAssembly.Module;
  let decoderCompiles = 0;
  vi.spyOn(WebAssembly, 'Module').mockImplementation(function (bytes: BufferSource) {
    if ((bytes as ArrayBufferView).byteLength > 8) {
      decoderCompiles += 1;
      throw new WebAssembly.CompileError('decoder blocked');
    }
    return new Real(bytes);
  } as never);
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation(() => Promise.reject(new WebAssembly.CompileError('decoder blocked')));
  vi.spyOn(WebAssembly, 'compile').mockImplementation(() => Promise.reject(new WebAssembly.CompileError('decoder blocked')));

  const m = await import('../inlineImages');
  expect(m.canCompileWasm()).toBe(true);
  expect(await m.preloadInlineImageAddon()).toBe(false);
  expect(decoderCompiles).toBeGreaterThan(0); // the probe really ran a decoder

  const t = new Terminal({ allowProposedApi: true });
  try {
    m.attachInlineImages(t);
    expect(m.getInlineImageAddon(t)).toBeNull();
    const out: string[] = [];
    t.onData((d) => out.push(d));
    await new Promise<void>((r) => t.write('\x1b[c\x1b]1337;File=inline=1;size=3:AAAA\x07still-here', r));
    expect(out).toEqual(['\x1b[?1;2c']);
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toContain('still-here');
  } finally {
    t.dispose();
  }
});
