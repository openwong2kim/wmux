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
 */
export function teardownWebglAddon(addon: WebglAddon): void {
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
}
