// Setup file of vitest.config.ts and vitest.rust-engine.config.ts. Panes run on
// the Rust terminal core only, so a test that starts a real terminal needs the
// built module, named by WMUX_TERMINAL_CORE_MODULE (the checkout's build is
// never found on its own: nativeCorePath).
//
// On CI the module is promised (ci.yml's native-core job builds it), and so is
// it under WMUX_REQUIRE_RUST_CORE=1: there a missing or broken module fails
// every test file at once, instead of each engine test failing or skipping on
// its own. A CI job that runs no such test opts out with
// WMUX_TERMINAL_CORE_NOT_NEEDED=1. Locally an unset path is allowed; the tests
// that need the module then fail with TERMINAL_CORE_MISSING.
//
// The module is checked with a plain require, not through
// shared/nativeTerminalCore: a module a setup file imports is already loaded
// when the test file's vi.mock calls run, and its load cache would carry over.
import { createRequire } from 'node:module';
import path from 'node:path';

// WMUX_RUST_SNAPSHOT_MODULE is the older name nativeCorePath still reads.
const modulePath = process.env.WMUX_TERMINAL_CORE_MODULE || process.env.WMUX_RUST_SNAPSHOT_MODULE;
const promised = process.env.WMUX_REQUIRE_RUST_CORE === '1'
  || (Boolean(process.env.CI) && process.env.WMUX_TERMINAL_CORE_NOT_NEEDED !== '1');
if (modulePath) {
  if (!path.isAbsolute(modulePath)) throw new Error(`WMUX_TERMINAL_CORE_MODULE must be absolute: ${modulePath}`);
  const core = createRequire(modulePath)(modulePath) as {
    nativeCoreAbiVersion?: () => number; nativeCoreCapabilities?: () => string[]; NativeTransport?: unknown; NativeRing?: unknown;
  };
  const capabilities = core.nativeCoreAbiVersion?.() === 1 ? core.nativeCoreCapabilities?.() ?? [] : [];
  for (const capability of ['pty-v1', 'ring-v1']) {
    if (!capabilities.includes(capability)) throw new Error(`The terminal core at ${modulePath} lacks ${capability} (or its ABI is not 1): rebuild it with npm run build:terminal-core`);
  }
  // The loader also needs the classes behind those names.
  for (const name of ['NativeTransport', 'NativeRing'] as const) {
    if (typeof core[name] !== 'function') throw new Error(`The terminal core at ${modulePath} does not export ${name}: rebuild it with npm run build:terminal-core`);
  }
} else if (promised) {
  throw new Error('These tests need the Rust terminal core: set WMUX_TERMINAL_CORE_MODULE=<absolute path of core/wmux-term/dist/native-core/index.cjs> after `npm run build:terminal-core` (or WMUX_TERMINAL_CORE_NOT_NEEDED=1 on a CI job that starts no terminal)');
}
