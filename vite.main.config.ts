import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    browserField: false,
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // `node-pty` is a native addon (must be required from disk, never bundled).
      // `@anthropic-ai/claude-agent-sdk` is kept external too: it ships its own
      // `claude` CLI and spawns it as a subprocess resolving paths relative to
      // its on-disk module location, so rollup-bundling it into index.js would
      // break that self-spawn. External → required from node_modules at runtime
      // (resolvable in dev; packaged builds must ship it unpacked from the asar —
      // see the Command Deck P2 deferred note in the impl plan).
      external: ['node-pty', '@anthropic-ai/claude-agent-sdk'],
    },
  },
});
