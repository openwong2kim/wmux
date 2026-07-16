const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

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
const chunkFile = path.join(outdir, 'playwright-chunk.js');
const chunkEntry = path.join(outdir, '.pw-chunk-entry.js');

async function main() {
  // 1. Main bundle — playwright-core external (lives in the chunk).
  await esbuild.build({
    entryPoints: ['dist/mcp/mcp/index.js'],
    bundle: true,
    platform: 'node',
    outfile,
    external: ['electron', 'chromium-bidi', 'playwright-core'],
    logLevel: 'error',
  });

  // 2. Lazy chunk — playwright-core bundled alone behind a re-export shim.
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(chunkEntry, "module.exports = require('playwright-core');\n");
  await esbuild.build({
    entryPoints: [chunkEntry],
    bundle: true,
    platform: 'node',
    outfile: chunkFile,
    external: ['electron', 'chromium-bidi'],
    logLevel: 'error',
  });
  fs.rmSync(chunkEntry, { force: true });

  // 3. Patch playwright's package.json self-resolve inside the chunk.
  let code = fs.readFileSync(chunkFile, 'utf8');
  let patched = 0;
  code = code.replace(
    /require\.resolve\("\.\.\/\.\.\/\.\.\/package\.json"\)/g,
    () => { patched++; return '__dirname + "/playwright-core-package.json"'; }
  );
  if (patched === 0) {
    throw new Error(
      'playwright-core self-resolve pattern not found in the chunk — the ' +
      'library changed its package.json resolution; update the patch in ' +
      'scripts/build-mcp.js'
    );
  }
  fs.writeFileSync(chunkFile, code);

  // Minimal package.json for playwright-core's version detection (same dir
  // as the chunk, __dirname-relative). Version mirrors the INSTALLED
  // library — the one actually bundled into the chunk.
  const pwVersion = require('playwright-core/package.json').version;
  fs.writeFileSync(
    path.join(outdir, 'playwright-core-package.json'),
    JSON.stringify({ name: 'playwright-core', version: pwVersion })
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
