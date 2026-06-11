import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { WebglAddon } from '@xterm/addon-webgl';
import { teardownWebglAddon } from '../webglTeardown';

/**
 * teardownWebglAddon does what xterm's WebglAddon.dispose() alone does not:
 * dispose() detaches the renderer but leaves the underlying WebGL2 context
 * alive ("zombie") until GC. Under split/tab churn those orphaned contexts pile
 * up past Chromium's ~16-context cap, which then force-evicts a LIVE pane's
 * context and renders it as an X-box / blank (#191 / #197). Teardown
 * force-releases the context via the WEBGL_lose_context extension so the real
 * live count drops immediately.
 */

function makeAddon(opts: { withGl?: boolean; disposeThrows?: boolean } = {}) {
  const { withGl = true, disposeThrows = false } = opts;
  const loseContext = vi.fn();
  const getExtension = vi.fn((name: string) =>
    name === 'WEBGL_lose_context' ? { loseContext } : null,
  );
  const dispose = vi.fn(() => {
    if (disposeThrows) throw new Error('already disposed');
  });
  const addon = {
    dispose,
    ...(withGl ? { _renderer: { _gl: { getExtension } } } : {}),
  } as unknown as WebglAddon;
  return { addon, dispose, getExtension, loseContext };
}

describe('teardownWebglAddon', () => {
  it('disposes the addon', () => {
    const f = makeAddon();
    teardownWebglAddon(f.addon);
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('force-releases the GL context via the WEBGL_lose_context extension', () => {
    const f = makeAddon();
    teardownWebglAddon(f.addon);
    expect(f.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(f.loseContext).toHaveBeenCalledOnce();
  });

  it('degrades to a plain dispose when the addon exposes no GL context', () => {
    const f = makeAddon({ withGl: false });
    expect(() => teardownWebglAddon(f.addon)).not.toThrow();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.loseContext).not.toHaveBeenCalled();
  });

  it('still releases the captured context when dispose throws', () => {
    const f = makeAddon({ disposeThrows: true });
    expect(() => teardownWebglAddon(f.addon)).not.toThrow();
    expect(f.loseContext).toHaveBeenCalledOnce();
  });
});

/**
 * Dependency-shape lock. teardownWebglAddon force-releases the context by
 * walking the private path addon._renderer._gl (WebglAddon._renderer →
 * WebglRenderer._gl). The behavioural tests above all mock that shape, so an
 * @xterm/addon-webgl bump that renamed those internals would let
 * teardownWebglAddon silently degrade to a plain dispose — the zombie-context
 * leak (#197) returns while every mock test stays green. Assert the two fields
 * still exist in the installed package source so such a bump fails loudly here.
 *
 * `this\._gl\b` is word-bounded on purpose: a bare /_gl/ also matches `_glyph`
 * (GlyphRenderer), which would keep passing even if WebglRenderer._gl were gone.
 */
describe('@xterm/addon-webgl private-path shape lock', () => {
  // The resolved dist (lib/addon-webgl.js) is a minified UMD bundle, but
  // property accesses like `this._renderer` / `this._gl` are NOT mangled, so
  // require.resolve()'s entry is a reliable target — no need for the .ts source.
  const addonSrc = readFileSync(require.resolve('@xterm/addon-webgl'), 'utf8');

  it('WebglAddon still exposes the _renderer field teardown reads', () => {
    expect(addonSrc).toMatch(/this\._renderer\b/);
  });

  it('WebglRenderer still exposes the _gl field teardown reads', () => {
    expect(addonSrc).toMatch(/this\._gl\b/);
  });
});
