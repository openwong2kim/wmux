import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The Windows computer-use helper's pin (src/main/computer/helperPin.ts). Read
// from the staged exe, which release.yml stages only after signing, so the
// hash covers the final bytes; release.yml checks the packaged exe against it
// after `make`. The release-signed flag comes from that job too, and only when
// a release (not test) signing policy produced a valid signature. A build with
// no staged helper bakes an empty pin.
const winHelper = path.join(__dirname, 'dist', 'computer-use-windows', 'wmux-computer-use.exe');
const winHelperSha256 = fs.existsSync(winHelper)
  ? createHash('sha256').update(fs.readFileSync(winHelper)).digest('hex')
  : '';

export default defineConfig({
  define: {
    __WMUX_WIN_HELPER_SHA256__: JSON.stringify(winHelperSha256),
    __WMUX_WIN_HELPER_RELEASE_SIGNED__: JSON.stringify(process.env.WMUX_WIN_HELPER_RELEASE_SIGNED === 'true'),
  },
  resolve: {
    browserField: false,
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // `node-pty` is a native addon (must be required from disk, never bundled).
      // `koffi` ships a prebuilt native binary that its loader resolves
      // relative to its own on-disk package location (@koromix/koffi-<triple>
      // sibling in the same node_modules), so it must stay external too —
      // see winSnapshotNative.ts.
      // `@anthropic-ai/claude-agent-sdk` is kept external too: it ships its own
      // `claude` CLI and spawns it as a subprocess resolving paths relative to
      // its on-disk module location, so rollup-bundling it into index.js would
      // break that self-spawn. External → required from node_modules at runtime
      // (resolvable in dev; packaged builds must ship it unpacked from the asar —
      // see the Command Deck P2 deferred note in the impl plan).
      // ws probes optional native accelerators at runtime; keep those optional requires intact.
      external: ['node-pty', 'koffi', 'ws', '@anthropic-ai/claude-agent-sdk'],
    },
  },
});
