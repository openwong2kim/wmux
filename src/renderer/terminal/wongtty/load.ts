// Lazy loader for the wongtty front end (`wongtty/xterm`, a Rust/WebAssembly
// terminal with the xterm.js API).
//
// EXPERIMENTAL (uiSlice.terminalWongtty, default off). The module and its two
// WebAssembly files are fetched the first time the flag is seen on. The
// renderer page cannot fetch file:// URLs, so main reads the .wasm bytes and
// hands them over IPC (settings.getWongttyWasm). Until init() has finished, a
// pane builds an xterm.js Terminal exactly as with the flag off, and keeps it:
// nothing swaps a pane's terminal once wongtty arrives.

import type * as WongttyModule from 'wongtty/xterm';

export type Wongtty = typeof WongttyModule;

let loaded: Wongtty | null = null;
let pending: Promise<Wongtty | null> | null = null;

/** Start loading wongtty, once. Resolves to the module after init(), or null
 *  when it failed; a failed load is retried on the next call. */
export function preloadWongtty(): Promise<Wongtty | null> {
  pending ??= (async () => {
    // eslint-disable-next-line import/no-unresolved -- the resolver does not read the package's `exports` subpath
    const [mod, wasm] = await Promise.all([import('wongtty/xterm'), window.electronAPI.settings.getWongttyWasm()]);
    await mod.init(wasm.engine, wasm.frontEnd);
    loaded = mod;
    return mod;
  })().catch((err: unknown) => {
    console.warn('[wmux:wongtty] could not load the wongtty front end', err);
    pending = null;
    return null;
  });
  return pending;
}

/** The module once init() has finished; null before (the caller uses xterm.js). */
export function loadedWongtty(): Wongtty | null {
  return loaded;
}

/** Whether `terminal` was built by wongtty. */
export function isWongttyTerminal(terminal: unknown): boolean {
  return loaded !== null && terminal instanceof loaded.Terminal;
}
