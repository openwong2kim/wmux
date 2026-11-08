const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { buildPlaywrightChunk } = require('./lib/playwright-chunk.cjs');

/**
 * Build the MCP bundle as TWO files (B0, app-weight P2 —
 * plans/mcp-broker-design-2026-07-16.md):
 *
 *   index.js            — the MCP server. playwright-core is EXTERNAL here,
 *                         so the idle child pays ~8-30 MB instead of ~80 MB.
 *   playwright-chunk.js — playwright-core bundled alone. Loaded at runtime by
 *                         src/mcp/playwright/lazyPlaywright.ts on the first
 *                         browser_* call that actually needs the library
 *                         (require path computed at runtime, so esbuild can't
 *                         re-inline it).
 *
 * playwright-core uses require.resolve("../../../package.json") to find its
 * root directory. In a single-file bundle, this relative path breaks.
 * Since we only use connectOverCDP (never launch browsers), we patch the
 * bundled output to stub the resolve with inline package metadata — the
 * patch now applies to the CHUNK (where the library lives).
 */
const outdir = 'dist/mcp-bundle';
const outfile = path.join(outdir, 'index.js');
const brokerFile = path.join(outdir, 'broker.js');
const shimFile = path.join(outdir, 'shim.js');
const chunkFile = path.join(outdir, 'playwright-chunk.js');
const packageVersion = require('../package.json').version;
const serverDefines = {
  __WMUX_MCP_VERSION__: JSON.stringify(packageVersion),
};

async function main() {
  // 1. Main bundle — playwright-core external (lives in the chunk).
  //    Entry is entry.ts (stdio single-child main); index.ts is the
  //    createWmuxServer factory with no import-time side effects. Output
  //    stays index.js so existing agent-config registrations keep working.
  await esbuild.build({
    entryPoints: ['dist/mcp/mcp/entry.js'],
    bundle: true,
    platform: 'node',
    outfile,
    external: ['electron', 'chromium-bidi', 'playwright-core'],
    define: serverDefines,
    logLevel: 'error',
  });

  // 1b. Broker bundle (Option A) — hosts N server instances over the broker
  //     pipe. Same externals as the main bundle so it inherits the lazy
  //     playwright chunk: the broker idles without playwright loaded and
  //     pays it ONCE (process-wide) on the first browser_* call.
  await esbuild.build({
    entryPoints: ['dist/mcp/mcp/broker.js'],
    bundle: true,
    platform: 'node',
    outfile: brokerFile,
    // koffi: a native binary resolved beside its package (copied into
    // mcp-bundle/node_modules at package time; src/shared/peerPid.ts).
    external: ['electron', 'chromium-bidi', 'playwright-core', 'koffi'],
    define: serverDefines,
    logLevel: 'error',
  });

  // 1c. Shim bundle — the per-agent stdio⇄pipe pump. MUST stay ~bare-node:
  //     no SDK, no zod, no playwright. The size assert below is the tripwire
  //     against someone accidentally importing the heavy world into it.
  await esbuild.build({
    entryPoints: ['dist/mcp/mcp/shim.js'],
    bundle: true,
    platform: 'node',
    outfile: shimFile,
    external: ['electron'],
    logLevel: 'error',
  });
  const shimBytes = fs.statSync(shimFile).size;
  if (shimBytes > 256 * 1024) {
    throw new Error(
      `mcp shim bundle is ${Math.round(shimBytes / 1024)} KB — it must stay ` +
      'tiny (something heavy leaked into src/mcp/shim.ts imports)'
    );
  }

  // 2-3. Lazy chunk — playwright-core bundled alone behind a re-export shim,
  //      its package.json self-resolve patched (scripts/lib/playwright-chunk.cjs).
  await buildPlaywrightChunk(outdir);

  // 4. ASCII-only output: one character above U+00FF makes V8 keep a whole
  //    script source as UTF-16 (scripts/lib/ascii-only-files.mjs).
  const { asciiOnlyFiles } = await import('./lib/ascii-only-files.mjs');
  asciiOnlyFiles([outfile, brokerFile, shimFile, chunkFile]);
}

main().catch((err) => { console.error(err); process.exit(1); });
