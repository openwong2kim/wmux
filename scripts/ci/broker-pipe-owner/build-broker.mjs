// Bundle the MCP broker from source for broker-pipe-owner.yml (the same
// esbuild options as the broker os tests), so the job runs the broker this
// commit builds.
//
//   node build-broker.mjs <out file>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const [outfile] = process.argv.slice(2);
if (!outfile) {
  console.error('usage: build-broker.mjs <out file>');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
buildSync({
  entryPoints: [path.join(root, 'src', 'mcp', 'broker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['electron', 'chromium-bidi', 'playwright-core', 'koffi'],
  define: { __WMUX_MCP_VERSION__: JSON.stringify('0.0.0-ci') },
  logLevel: 'error',
});
