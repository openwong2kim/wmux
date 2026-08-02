import type { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';

/**
 * Tear down a WebGL addon AND force-release its underlying GL context.
 *
 * xterm's `WebglAddon.dispose()` detaches the renderer but does NOT free the
 * underlying WebGL2 context — it lingers ("zombie") until GC. Under split/tab
 * churn these orphaned contexts pile up past Chromium's ~16-context cap, which
 * then force-evicts a LIVE pane's context (`webglcontextlost`) and renders it
 * as an X-box / blank / garble. Calling `WEBGL_lose_context.loseContext()`
 * drops the real count immediately, so the pool's budget actually bounds the
 * number of live contexts (#191 / #197).
 *
 * The context is captured BEFORE dispose (dispose may detach the renderer) and
 * field access is guarded: if the addon internals ever change shape, `gl` is
 * undefined and we degrade to a plain dispose (zombie returns, but no crash).
 *
 * --- Renderer-restore guarantee (flicker-then-black RCA, 2026-08-02) ---
 *
 * WebglAddon registers its "hand the terminal back to the DOM renderer" step
 * as a disposable inside its own DisposableStore. If ANY earlier disposable in
 * that store throws mid-dispose (GL work against a dying context can), the
 * store's loop aborts and the restore step never runs. Our catch below
 * swallows that throw — correct for teardown robustness, but it used to leave
 * the pane with NO renderer at all: xterm's `RenderService.dimensions` getter
 * reads `_renderer.value.dimensions` unguarded, so every subsequent render
 * tick (cursor blink, scroll, fit) threw
 * `Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')`
 * — observed 2,990× across one 85-minute production storm — and the pane
 * flickered, then stayed black until relaunch. The refresh()-based repaint
 * band-aids (#166/#191/#318) never touched this layer: they repaint THROUGH
 * the render service, which is exactly the thing that is broken here.
 *
 * So after dispose we VERIFY the render service still holds a renderer and,
 * if it does not, restore the DOM renderer ourselves — the same
 * `setRenderer(_createRenderer())` + `handleResize` sequence the addon's own
 * skipped disposable would have run. Every private-path access is optional-
 * chained: on an internals change we degrade to the old behaviour (no restore,
 * no crash) and the shape-lock test fails loudly instead.
 */

/** Private xterm internals walked by the renderer-restore step. Kept in one
 *  named shape so webglTeardown.test.ts can lock the exact paths against
 *  @xterm package bumps. */
interface XtermCoreInternals {
  _core?: {
    _store?: { _isDisposed?: boolean };
    _renderService?: {
      _renderer?: { value?: unknown };
      setRenderer?: (renderer: unknown) => void;
      handleResize?: (cols: number, rows: number) => void;
    };
    _createRenderer?: () => unknown;
  };
}

/**
 * True when the terminal is live but its RenderService has no renderer — the
 * "every render tick throws" state this module exists to prevent. Exported so
 * tests can assert the invariant directly.
 */
export function isRendererMissing(terminal: Terminal): boolean {
  const core = (terminal as unknown as XtermCoreInternals)._core;
  if (!core || core._store?._isDisposed) return false;
  const renderer = core._renderService?._renderer;
  if (!renderer) return false;
  return renderer.value === undefined || renderer.value === null;
}

/** Restore xterm's DOM renderer when the WebGL addon's own restore step was
 *  skipped by a throw mid-dispose. No-op when a renderer is present, the
 *  terminal is disposed, or the private internals changed shape. */
function ensureRendererRestored(terminal: Terminal): void {
  try {
    if (!isRendererMissing(terminal)) return;
    const core = (terminal as unknown as XtermCoreInternals)._core;
    const renderService = core?._renderService;
    const createRenderer = core?._createRenderer;
    if (!renderService?.setRenderer || typeof createRenderer !== 'function') return;
    renderService.setRenderer(createRenderer.call(core));
    // Mirror the addon's skipped restore step: a resize re-derives the DOM
    // renderer's dimensions so the very next render tick paints correctly.
    renderService.handleResize?.(terminal.cols, terminal.rows);
    console.warn('[Terminal] WebGL dispose left no renderer — restored the DOM renderer');
  } catch {
    /* restore is best-effort; never let it break teardown */
  }
}

export function teardownWebglAddon(addon: WebglAddon, terminal?: Terminal): void {
  const gl = (addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext } })._renderer?._gl;
  try {
    addon.dispose();
  } catch {
    /* already disposed */
  }
  try {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* best effort — context may already be lost */
  }
  if (terminal) ensureRendererRestored(terminal);
}
