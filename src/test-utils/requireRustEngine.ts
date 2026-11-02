// Setup file of vitest.rust-engine.config.ts. The rust engine falls back to
// node, with only a warning, when the native module does not load, so without
// this check a broken build would pass that whole run on node. Fail every test
// file instead.
import { loadNativeTerminalCore } from '../shared/nativeTerminalCore';

if (process.env.WMUX_TERMINAL_CORE !== 'rust') {
  throw new Error('vitest.rust-engine.config.ts needs WMUX_TERMINAL_CORE=rust');
}
// The checkout's build is never found on its own (nativeCorePath).
if (!process.env.WMUX_TERMINAL_CORE_MODULE) {
  throw new Error('vitest.rust-engine.config.ts needs WMUX_TERMINAL_CORE_MODULE=<absolute path of core/wmux-term/dist/native-core/index.cjs>');
}
for (const capability of ['pty-v1', 'ring-v1']) loadNativeTerminalCore(capability);
