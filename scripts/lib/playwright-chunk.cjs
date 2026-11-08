// The MCP bundle's lazy chunk: playwright-core bundled alone behind a
// re-export shim, loaded at runtime by the MCP server (scripts/build-mcp.js).
// Shared with the real-Chrome test that drives that chunk over the pipe relay.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

/** Build `<outdir>/playwright-chunk.js` and its package.json stand-in; returns the chunk's path. */
async function buildPlaywrightChunk(outdir) {
  const chunkFile = path.join(outdir, 'playwright-chunk.js');
  const chunkEntry = path.join(outdir, '.pw-chunk-entry.js');
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(chunkEntry, "module.exports = require('playwright-core');\n");
  await esbuild.build({
    entryPoints: [chunkEntry],
    bundle: true,
    platform: 'node',
    outfile: chunkFile,
    external: ['electron', 'chromium-bidi'],
    // The repo's own playwright-core, wherever `outdir` is.
    nodePaths: [path.join(repoRoot, 'node_modules')],
    logLevel: 'error',
  });
  fs.rmSync(chunkEntry, { force: true });

  // Patch playwright's package.json self-resolve inside the chunk.
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
      'scripts/lib/playwright-chunk.cjs'
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
  return chunkFile;
}

module.exports = { buildPlaywrightChunk };
