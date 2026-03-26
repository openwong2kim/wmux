const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

/**
 * Build MCP bundle with playwright-core included.
 *
 * playwright-core uses require.resolve("../../../package.json") to find its
 * root directory. In a single-file bundle, this relative path breaks.
 * Since we only use connectOverCDP (never launch browsers), we patch the
 * bundled output to stub the resolve with inline package metadata.
 */
const outfile = 'dist/mcp-bundle/index.js';

esbuild.build({
  entryPoints: ['dist/mcp/mcp/index.js'],
  bundle: true,
  platform: 'node',
  outfile,
  external: ['electron', 'chromium-bidi'],
  logLevel: 'warning',
}).then(() => {
  let code = fs.readFileSync(outfile, 'utf8');

  // Stub require.resolve("../../../package.json") → inline path to a
  // virtual package.json we write next to the bundle.
  code = code.replace(
    /require\.resolve\("\.\.\/\.\.\/\.\.\/package\.json"\)/g,
    '__dirname + "/playwright-core-package.json"'
  );

  fs.writeFileSync(outfile, code);

  // Write a minimal package.json for playwright-core's version detection.
  fs.writeFileSync(
    path.join(path.dirname(outfile), 'playwright-core-package.json'),
    JSON.stringify({ name: 'playwright-core', version: '1.58.2' })
  );
}).catch(() => process.exit(1));
