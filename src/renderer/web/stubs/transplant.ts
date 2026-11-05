/**
 * Browser-build stand-in (vite.web.config.ts) for terminal/wongtty/transplant.ts:
 * the browser build never swaps a terminal's engine (stubs/engineController.ts),
 * and the serialize addon's HTML half must stay out of its inlined script.
 */
export function serializeForTransplant(): null {
  return null;
}
