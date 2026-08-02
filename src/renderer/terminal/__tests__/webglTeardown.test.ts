import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';
import { teardownWebglAddon, isRendererMissing } from '../webglTeardown';

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
 * Renderer-restore guarantee (flicker-then-black RCA, 2026-08-02).
 *
 * WebglAddon.dispose() restores the DOM renderer via a disposable in its own
 * DisposableStore; a throw from an EARLIER disposable aborts that loop, so the
 * restore never runs and the pane is left with `_renderer.value === undefined`.
 * xterm's RenderService.dimensions getter then throws on every render tick
 * (`Cannot read properties of undefined (reading 'dimensions')`) — the pane
 * flickers and settles black. teardownWebglAddon must detect that state and
 * restore the DOM renderer itself.
 */
function makeTerminal(opts: {
  rendererValue?: unknown;
  disposed?: boolean;
} = {}) {
  const { rendererValue, disposed = false } = opts;
  const domRenderer = { kind: 'dom' };
  const setRenderer = vi.fn();
  const handleResize = vi.fn();
  const createRenderer = vi.fn(() => domRenderer);
  const terminal = {
    cols: 80,
    rows: 24,
    _core: {
      _store: { _isDisposed: disposed },
      _renderService: {
        _renderer: { value: rendererValue },
        setRenderer,
        handleResize,
      },
      _createRenderer: createRenderer,
    },
  } as unknown as Terminal;
  return { terminal, domRenderer, setRenderer, handleResize, createRenderer };
}

describe('teardownWebglAddon renderer-restore guarantee', () => {
  it('restores the DOM renderer when dispose left the render service empty', () => {
    const f = makeAddon({ disposeThrows: true });
    const t = makeTerminal({ rendererValue: undefined });
    teardownWebglAddon(f.addon, t.terminal);
    expect(t.createRenderer).toHaveBeenCalledOnce();
    expect(t.setRenderer).toHaveBeenCalledWith(t.domRenderer);
    // Mirrors the addon's skipped restore step: re-derive dimensions so the
    // next render tick paints instead of throwing.
    expect(t.handleResize).toHaveBeenCalledWith(80, 24);
  });

  it('leaves a live renderer alone (the normal dispose path)', () => {
    const f = makeAddon();
    const t = makeTerminal({ rendererValue: { kind: 'dom' } });
    teardownWebglAddon(f.addon, t.terminal);
    expect(t.setRenderer).not.toHaveBeenCalled();
    expect(t.createRenderer).not.toHaveBeenCalled();
  });

  it('does not restore into a disposed terminal', () => {
    const f = makeAddon();
    const t = makeTerminal({ rendererValue: undefined, disposed: true });
    teardownWebglAddon(f.addon, t.terminal);
    expect(t.setRenderer).not.toHaveBeenCalled();
  });

  it('degrades to a no-op when the private internals changed shape', () => {
    const f = makeAddon();
    const terminal = { cols: 80, rows: 24, _core: {} } as unknown as Terminal;
    expect(() => teardownWebglAddon(f.addon, terminal)).not.toThrow();
  });

  it('isRendererMissing reports the rendererless-but-live state only', () => {
    expect(isRendererMissing(makeTerminal({ rendererValue: undefined }).terminal)).toBe(true);
    expect(isRendererMissing(makeTerminal({ rendererValue: { kind: 'dom' } }).terminal)).toBe(false);
    expect(isRendererMissing(makeTerminal({ rendererValue: undefined, disposed: true }).terminal)).toBe(false);
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

/**
 * Shape lock for the renderer-restore path. ensureRendererRestored replays the
 * exact sequence WebglAddon's own (skippable) restore disposable runs:
 * `_core._renderService.setRenderer(_core._createRenderer())` + `handleResize`.
 * And isRendererMissing keys off RenderService reading `_renderer.value` —
 * the unguarded getter whose throw IS the flicker-then-black symptom. If an
 * @xterm bump renames any of these, the restore silently degrades to a no-op
 * (the black-pane bug returns) while the mock tests stay green — so pin the
 * paths against the installed package sources here.
 */
describe('renderer-restore private-path shape lock', () => {
  const addonSrc = readFileSync(require.resolve('@xterm/addon-webgl'), 'utf8');
  const xtermSrc = readFileSync(require.resolve('@xterm/xterm'), 'utf8');

  it('WebglAddon still restores via _core._renderService.setRenderer(_core._createRenderer())', () => {
    expect(addonSrc).toMatch(/_core\._renderService/);
    expect(addonSrc).toMatch(/setRenderer\([^)]*_createRenderer\(\)/);
  });

  it('the restore step still re-derives dimensions via handleResize', () => {
    expect(addonSrc).toMatch(/\.handleResize\(/);
  });

  it('RenderService still reads the unguarded _renderer.value the restore repairs', () => {
    expect(xtermSrc).toMatch(/this\._renderer\.value\.dimensions/);
  });

  it('Terminal core still tracks disposal via _store._isDisposed', () => {
    expect(addonSrc).toMatch(/_core\._store\._isDisposed/);
  });
});
