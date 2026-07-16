// B0 (app-weight P2, plans/mcp-broker-design-2026-07-16.md): playwright-core
// is ~70 MB of module-init the average agent pane never touches — measured
// 80.9 MB idle for the old eager bundle vs 8 MB for bare node. The library
// now ships as a SEPARATE sibling bundle (playwright-chunk.js, built by
// scripts/build-mcp.js) and its module graph initializes on the FIRST call
// that actually needs it (chromium.connectOverCDP / device emulation).
//
// Resolution order:
//   1. `<bundle dir>/playwright-chunk.js` — the packaged/bundled layout. The
//      path is computed at runtime, so esbuild cannot inline the chunk back
//      into the main bundle.
//   2. bare `require('playwright-core')` — dev/tsc and vitest layouts, where
//      node_modules is available. playwright-core is marked external in the
//      MAIN bundle build, so this literal stays a runtime require and can
//      never re-inline the library.
import path from 'node:path';
import type * as PlaywrightCore from 'playwright-core';

let mod: typeof PlaywrightCore | null = null;

export function loadPlaywright(): typeof PlaywrightCore {
  if (mod) return mod;
  const chunk = path.join(__dirname, 'playwright-chunk.js');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(chunk) as typeof PlaywrightCore;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('playwright-core') as typeof PlaywrightCore;
  }
  return mod;
}

/** Test seam: report whether the library has been loaded yet. */
export function __isPlaywrightLoaded(): boolean {
  return mod !== null;
}
