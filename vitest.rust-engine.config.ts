import { configDefaults, defineConfig } from 'vitest/config';
import { hashbangLf } from './scripts/lib/vitest-hashbang-lf.mjs';

// The daemon's tests on the Rust terminal core, on Linux against real shells.
// Run by .github/workflows/rust-engine-daemon.yml after `npm run build:terminal-core`:
//
//   WMUX_REQUIRE_RUST_CORE=1 \
//   WMUX_TERMINAL_CORE_MODULE="$PWD/core/wmux-term/dist/native-core/index.cjs" \
//     npx vitest run --config vitest.rust-engine.config.ts
//
// The Rust core is the only engine, so the normal lanes run these files on it
// too; this run adds src/daemon's integration files on Linux, where ci.yml's
// integration lane runs on Windows. src/test-utils/requireRustEngine.ts fails
// the run when the module is missing or does not load. Files that fake the PTY
// with a node-pty mock route the Rust spawn to that mock
// (src/test-utils/ptyTransportStub.ts), so no file is left out.
export default defineConfig({
  // A CRLF hashbang line loads (scripts/lib/vitest-hashbang-lf.mjs).
  plugins: [hashbangLf()],
  test: {
    include: ['src/daemon/**/__tests__/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.runtime.test.ts'],
    environment: 'node',
    // Same setup as vitest.config.ts, which includes the engine check.
    setupFiles: ['./src/test-utils/requireRustEngine.ts', './src/test-utils/isolateDataDir.ts', './src/test-utils/jsdomEnv.ts'],
    globalSetup: ['./scripts/vitest-electron-binary.mjs'],
    // The integration lane's limits (vitest.config.ts): these files spawn
    // shells and open sockets.
    maxWorkers: '50%',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: process.env.CI ? 1 : 0,
  },
});
