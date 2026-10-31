import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { hashbangLf } from './scripts/lib/vitest-hashbang-lf.mjs';

// The daemon's tests on the rust terminal engine (WMUX_TERMINAL_CORE=rust).
// Run by .github/workflows/rust-engine-daemon.yml after `npm run build:terminal-core`:
//
//   WMUX_TERMINAL_CORE=rust WMUX_REQUIRE_RUST_CORE=1 \
//     npx vitest run --config vitest.rust-engine.config.ts
//
// src/test-utils/requireRustEngine.ts fails the run when the native module
// does not load. With the engine set, every RingBuffer the tests build with the default
// backend is the native ring, every spawned PTY is the native transport, and
// text snapshots go through the native serializer.
//
// These files assume the node engine, so they are left out here and run only
// in the normal lanes:
const nodeOnly = [
  // Mock node-pty. The rust engine never calls node-pty, so a "mocked" spawn
  // starts a real shell (cmd.exe on a mocked win32 fails to start at all).
  'src/daemon/__tests__/DaemonSessionManager.os.test.ts',
  'src/daemon/__tests__/DaemonSessionManager.wslSecretEnv.os.test.ts',
  'src/daemon/__tests__/DaemonSessionManager.secretEnv.test.ts',
  'src/daemon/__tests__/DaemonSessionManager.hostWindow.test.ts',
  'src/daemon/__tests__/spawnCwdRefusal.os.test.ts',
  'src/daemon/__tests__/spawnStartTimeRetry.os.test.ts',
  'src/daemon/__tests__/wslDistroSpawnArgs.os.test.ts',
  'src/daemon/__tests__/createSessionPid.test.ts',
  'src/daemon/__tests__/createSessionPersistence.test.ts',
  'src/daemon/__tests__/DaemonSessionManager.claudeFileSend.test.ts',
  'src/daemon/__tests__/runSnapshotOnce.test.ts',
  // Test the opt-in WMUX_RUST_SNAPSHOT path with a stubbed module; the rust
  // engine selects the built module and the text backend instead.
  'src/daemon/__tests__/TextSnapshotBackend.test.ts',
  'src/daemon/__tests__/RustSnapshot.test.ts',
];
// A renamed file would otherwise drop out of this list and back into the run.
const root = path.dirname(fileURLToPath(import.meta.url));
for (const file of nodeOnly) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`vitest.rust-engine.config.ts: ${file} does not exist (renamed or deleted?)`);
}

export default defineConfig({
  // A CRLF hashbang line loads (scripts/lib/vitest-hashbang-lf.mjs).
  plugins: [hashbangLf()],
  test: {
    include: ['src/daemon/**/__tests__/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.runtime.test.ts', ...nodeOnly],
    environment: 'node',
    // Same setup as vitest.config.ts, plus the engine check.
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
